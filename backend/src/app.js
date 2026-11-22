'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const { requireAuth, requireRole } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { activityLogger } = require('./services/activity');
const settingsService = require('./services/settings');
const deviceService = require('./services/devices');

function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false); // so rate limiting sees the real client IP behind one proxy

  const api = express.Router();
  api.use(helmet({
    crossOriginOpenerPolicy: { policy: 'unsafe-none' }
  }));
  if (config.corsOrigins.length) {
    api.use(cors({ origin: config.corsOrigins, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id'], exposedHeaders: ['X-Refresh-Token'], maxAge: 600 }));
  }
  api.use(express.json({ limit: '1mb' }));

  api.get('/health', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
    catch (_) { res.status(503).json({ status: 'error', error: 'Database unavailable' }); }
  });

  const guard = requireAuth(pool);
  api.use('/auth', require('./routes/auth')(pool));
  const maintenance = settingsService.maintenanceGate(pool);                    // 503 for students / drivers while an administrator has maintenance mode on
  api.use('/student-portal', maintenance, require('./routes/studentPortal')(pool)); // student sign-up / login / own pass (must come before the '/' guard below)
  // Role-based access: administrators run the registry, drivers run their own dashboard, both may scan.
  const logged = activityLogger(pool);                                 // records who changed what (Recent system activities)
  api.use('/admin/dashboard', guard, requireRole('admin'), require('./routes/adminDashboard')(pool)); // administrator dashboard numbers (before '/admin' below)
  // Administrator modules (applications, driver documents, vehicles, routes, trips, devices, announcements, notifications, refunds, suspicious activity, settings, backups).
  const adminModules = require('./routes/modules');
  for (const [prefix, router] of Object.entries(adminModules(pool))) api.use(`/admin/${prefix}`, guard, logged, requireRole('admin'), router);
  api.use('/admin', guard, logged, require('./routes/admin')(pool));             // account = any staff; management routes check the admin role themselves
  api.use('/driver/notifications', guard, requireRole('driver'), maintenance, adminModules.driverInbox(pool)); // a driver's own notification inbox
  api.use('/driver', guard, requireRole('driver'), maintenance, require('./routes/driver')(pool));
  api.use('/scanner', guard, requireRole('driver', 'admin'), maintenance, deviceService.gate(pool), require('./routes/scanner')(pool));
  api.use('/students', guard, logged, requireRole('admin'), require('./routes/students')(pool));
  api.use('/', guard, logged, requireRole('admin'), require('./routes/reports')(pool));
  api.use(notFoundHandler);

  app.use('/api', api);

  // Optional: serve the static frontend from the same origin (no CORS needed, camera works on localhost).
  if (config.frontendDir) {
    const dir = path.resolve(config.frontendDir);
    if (fs.existsSync(dir)) app.use(express.static(dir));
    else console.warn(`[config] FRONTEND_DIR not found: ${dir}`);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
