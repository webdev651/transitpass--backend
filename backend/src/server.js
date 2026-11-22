'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('./config');
const { createPool } = require('./db');
const { createApp } = require('./app');
const { migrate } = require('../scripts/migrate');
const { ensureDriver } = require('./lib/ensureDriver');
const scheduler = require('./services/scheduler');

/** The addresses other devices on the same Wi-Fi can use, e.g. ["192.168.1.23"]. */
function networkAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) found.push(i.address);
    }
  }
  return found;
}

function printUrls(port, isHttps) {
  const protocol = isHttps ? 'https' : 'http';
  const line = (label, url) => console.log(`  ${label.padEnd(14)} ${url}`);
  console.log(`\nTransitPass is running (${config.nodeEnv})`);
  line('This computer:', `${protocol}://localhost:${port}`);
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    console.log('  (HOST limits this to your computer. Remove HOST from .env to open it to your phone.)');
  } else {
    const ips = networkAddresses();
    if (!ips.length) console.log('  No network address found. Connect to Wi-Fi to test on your phone.');
    ips.forEach((ip) => line('On your phone:', `${protocol}://${ip}:${port}   (same Wi-Fi)`));
  }
  if (!config.frontendDir) console.log('  Frontend folder not found: set FRONTEND_DIR in .env to serve the pages.');
  if (!config.isProd) line('Admin login:', `${config.seedAdmin.username} / ${config.seedAdmin.password}   (create drivers from the admin dashboard)`);
  console.log('');
}

function getProcessUsingPort(port) {
  try {
    const { execSync } = require('child_process');
    const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: 'pipe' });
    const lines = output.trim().split('\n');
    const pids = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const pid = parts[4];
        if (pid && pid !== '0') pids.add(pid);
      }
    }
    if (pids.size > 0) {
      const details = [];
      for (const pid of pids) {
        try {
          const procOutput = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV`, { encoding: 'utf8', stdio: 'pipe' });
          const procLines = procOutput.trim().split('\n');
          if (procLines.length >= 2) details.push(procLines[1].replace(/"/g, ''));
        } catch (_) {}
      }
      return details.length > 0 ? details.join(', ') : Array.from(pids).join(', ');
    }
  } catch (_) {}
  return null;
}

async function main() {
  await migrate({ quiet: true });
  const pool = createPool();
  await pool.query('SELECT 1');
  await ensureDriver(pool, console.log);

  const app = createApp(pool);
  const stopJobs = scheduler.start(pool);

  // HTTP server (optional)
  let server;
  if (config.port) {
    server = http.createServer(app);

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const procInfo = getProcessUsingPort(config.port);
        const msg = procInfo
          ? `Port ${config.port} is already in use by process(es): ${procInfo}. Stop the other program or set PORT in .env.`
          : `Port ${config.port} is already in use. Stop the other program or set PORT in .env.`;
        console.error(msg);
      } else {
        console.error(`Failed to start: ${err.message}`);
      }
      process.exit(1);
    });

    const shutdown = (sig) => {
      console.log(`${sig} received, shutting down`);
      stopJobs();
      if (server) server.close(() => pool.end().finally(() => process.exit(0)));
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('Starting HTTP server...');
    server.listen(config.port, config.host, () => printUrls(config.port, false));
  } else {
    console.log('HTTP server disabled (PORT not set). Use HTTPS only.');
  }

  // HTTPS server (optional, separate port)
  if (config.httpsPort) {
    const certPath = path.join(__dirname, '..', 'certs', 'dev-cert.pem');
    const keyPath = path.join(__dirname, '..', 'certs', 'dev-key.pem');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const httpsServer = https.createServer({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath)
      }, app);

      httpsServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          const procInfo = getProcessUsingPort(config.httpsPort);
          const msg = procInfo
            ? `HTTPS Port ${config.httpsPort} is already in use by process(es): ${procInfo}. Stop the other program or set HTTPS_PORT in .env.`
            : `HTTPS Port ${config.httpsPort} is already in use. Stop the other program or set HTTPS_PORT in .env.`;
          console.error(msg);
        } else {
          console.error(`Failed to start HTTPS: ${err.message}`);
        }
      });

      console.log('Starting HTTPS server...');
      httpsServer.listen(config.httpsPort, config.host, () => printUrls(config.httpsPort, true));
    } else {
      console.warn(`HTTPS certificates not found at ${certPath} / ${keyPath}. Skipping HTTPS server.`);
    }
  }
}

main().catch((err) => { console.error('Failed to start:', err.message); process.exit(1); });