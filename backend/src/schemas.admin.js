'use strict';
// Validation for the admin modules. Kept separate from schemas.js so the existing schemas are untouched.
const { z } = require('zod');
const { isRealDate } = require('./lib/dates');

const page = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) });
const text = (max, label) => z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);
const optText = (max) => z.string().trim().max(max).optional().transform((v) => (v === '' ? undefined : v));
const ymd = z.string().refine(isRealDate, 'Use a real date in the format YYYY-MM-DD');
const optYmd = z.union([ymd, z.literal('')]).optional().transform((v) => (v === '' ? undefined : v));
const id = z.coerce.number().int().positive();
const reason = (label = 'Reason', min = 3) => z.string().trim().min(min, `${label} is required (at least ${min} characters)`).max(255);
const q = z.string().trim().max(100).optional();

const plate = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 -]{2,18}$/, 'Enter a valid plate number (letters, numbers, spaces and - only)');
const vehicleBase = {
  name: text(100, 'Vehicle name'), type: text(40, 'Vehicle type'), plateNumber: plate,
  capacity: z.coerce.number().int().min(1, 'Capacity must be at least 1').max(200, 'Capacity is too large'),
  registrationNo: optText(60), registrationExpiry: optYmd, notes: optText(255)
};
const vehicleCreate = z.object({ ...vehicleBase, status: z.enum(['active', 'maintenance']).default('active') });
const vehicleUpdate = z.object({ ...vehicleBase, notes: z.string().trim().max(255), registrationNo: z.string().trim().max(60), registrationExpiry: z.union([ymd, z.literal('')]) }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const vehicleList = page.extend({ q, status: z.enum(['all', 'active', 'inactive', 'maintenance']).default('all'), type: z.string().trim().max(40).optional(), assigned: z.enum(['all', 'assigned', 'unassigned']).default('all') });
const vehicleStatus = z.object({ status: z.enum(['active', 'inactive', 'maintenance']) });
const driverRef = z.object({ driverId: id });

const routeBase = { name: text(120, 'Route name'), origin: text(120, 'Starting location'), destination: text(120, 'Destination'), description: optText(500) };
const routeCreate = z.object({ ...routeBase, status: z.enum(['active', 'inactive']).default('active') }).refine((o) => o.origin.toLowerCase() !== o.destination.toLowerCase(), { message: 'The starting location and destination must be different', path: ['destination'] });
const routeUpdate = z.object({ ...routeBase, description: z.string().trim().max(500) }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const routeList = page.extend({ q, status: z.enum(['all', 'active', 'inactive']).default('all') });
const routeStatus = z.object({ status: z.enum(['active', 'inactive']) });
const vehicleRef = z.object({ vehicleId: id });

const dt = z.coerce.date({ message: 'Enter a valid date and time' });
const tripCreate = z.object({ routeId: id, vehicleId: id, driverId: id, startTime: dt, endTime: dt, notes: optText(255) });
const tripUpdate = z.object({ routeId: id, vehicleId: id, driverId: id, startTime: dt, endTime: dt, notes: z.string().trim().max(255), passengerCount: z.coerce.number().int().min(0).max(100000) }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const tripList = page.extend({ q, from: ymd.optional(), to: ymd.optional(), status: z.enum(['all', 'scheduled', 'ongoing', 'completed', 'cancelled']).default('all'), driverId: id.optional(), vehicleId: id.optional(), routeId: id.optional() });
const tripComplete = z.object({ passengerCount: z.coerce.number().int().min(0).max(100000).optional() }).default({});
const tripCancel = z.object({ reason: reason('Cancellation reason') });
const tripMonitor = z.object({ period: z.enum(['daily', 'monthly']).default('daily'), date: z.string().trim().max(10).default('') });

const docUpload = z.object({ driverId: id, type: z.enum(['license', 'government_id']), documentNo: optText(60), expiresOn: optYmd });
const docList = page.extend({ q, status: z.enum(['all', 'pending', 'verified', 'rejected', 'expired']).default('all'), type: z.enum(['all', 'license', 'government_id']).default('all'), driverId: id.optional(), expiry: z.enum(['all', 'expiring', 'expired']).default('all'), history: z.enum(['0', '1']).default('0').transform((v) => v === '1') });
const docReview = z.object({ decision: z.enum(['verified', 'rejected']), reason: z.string().trim().max(255).optional() })
  .refine((o) => o.decision !== 'rejected' || (o.reason && o.reason.length >= 3), { message: 'Give a reason (at least 3 characters)', path: ['reason'] });
const driverStatusList = page.extend({ q, status: z.enum(['all', 'verified', 'pending', 'rejected', 'expired', 'incomplete']).default('all') });

const deviceRegister = z.object({ driverId: id, identifier: text(100, 'Device identifier'), name: text(120, 'Device name'), platform: optText(60) });
const deviceList = page.extend({ q, driverId: id.optional(), status: z.enum(['all', 'active', 'inactive', 'removed']).default('all') });
const deviceStatus = z.object({ status: z.enum(['active', 'inactive']) });
const deviceRemove = z.object({ reason: reason('Reason') });
const deviceHistory = page.extend({ deviceId: id.optional(), driverId: id.optional() });

const annBase = { title: text(200, 'Title'), body: text(5000, 'Description'), audience: z.enum(['all', 'students', 'drivers']).default('all'), publishAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional() };
const annCreate = z.object({ ...annBase, publish: z.enum(['draft', 'now']).default('draft') });
const annUpdate = z.object({ title: annBase.title, body: annBase.body, audience: z.enum(['all', 'students', 'drivers']), publishAt: z.coerce.date().nullable(), expiresAt: z.coerce.date().nullable() }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const annList = page.extend({ q, status: z.enum(['all', 'draft', 'scheduled', 'published', 'expired', 'deactivated']).default('all'), audience: z.enum(['all', 'students', 'drivers']).default('all') });

const CATS = ['account_status', 'eligibility_expiry', 'qr_expiry', 'announcement', 'refund', 'general'];
const notifList = page.extend({ q, recipientType: z.enum(['all', 'student', 'driver']).default('all'), category: z.enum(['all', ...CATS]).default('all'), read: z.enum(['all', 'read', 'unread']).default('all'), delivery: z.enum(['all', 'delivered', 'failed']).default('all') });
const notifSend = z.object({
  audience: z.enum(['students', 'drivers', 'selected_students', 'selected_drivers']), studentIds: z.array(z.string().trim().min(1).max(32)).max(500).default([]), driverIds: z.array(id).max(500).default([]),
  category: z.enum(['account_status', 'eligibility_expiry', 'qr_expiry', 'general']).default('general'), title: text(200, 'Title'), body: text(2000, 'Message')
}).refine((o) => o.audience !== 'selected_students' || o.studentIds.length, { message: 'Choose at least one student', path: ['studentIds'] })
  .refine((o) => o.audience !== 'selected_drivers' || o.driverIds.length, { message: 'Choose at least one driver', path: ['driverIds'] });

const refundList = page.extend({ q, status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all') });
const refundCreate = z.object({ scanId: id, amount: z.coerce.number().positive().max(100000).optional(), reason: z.string().trim().min(5, 'Record the refund reason (at least 5 characters)').max(500) });
const refundDecide = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().max(255).optional(), password: z.string().min(1, 'Enter your password to authorize this').max(200) })
  .refine((o) => o.decision !== 'rejected' || (o.reason && o.reason.length >= 3), { message: 'Give a reason for rejecting (at least 3 characters)', path: ['reason'] });
const txnList = page.extend({ q, state: z.enum(['all', 'active', 'cancelled']).default('all'), from: ymd.optional(), to: ymd.optional() });
const txnCancel = z.object({ reason: z.string().trim().min(5, 'Record the cancellation reason (at least 5 characters)').max(500), password: z.string().min(1, 'Enter your password to authorize this').max(200) });
const cancelList = page.extend({ q });
// Transaction Management: the filters are shared by the list, the totals, the printable report and the CSV export.
const txnFilters = { q, driverId: id.optional(), routeId: id.optional(), from: ymd.optional(), to: ymd.optional(), status: z.enum(['all', 'completed', 'cancelled', 'refunded']).default('all') };
const txnRange = (o) => !o.from || !o.to || o.from <= o.to;
const txnRangeMsg = { message: 'The start date must not be after the end date', path: ['to'] };
const txnMgmtList = z.object({ ...page.shape, ...txnFilters }).refine(txnRange, txnRangeMsg);
const txnMgmtFilter = z.object(txnFilters).refine(txnRange, txnRangeMsg);

// Activity logs (read only)
const logFilters = { q, type: z.string().trim().max(30).regex(/^[a-z_]+$/, 'Unknown activity type').optional(), status: z.enum(['all', 'success', 'failed']).default('all'), from: optYmd, to: optYmd };
const logRange = (o) => !o.from || !o.to || o.from <= o.to;
const logRangeMsg = { message: 'The start date must not be after the end date', path: ['to'] };
const logList = z.object({ ...page.shape, ...logFilters }).refine(logRange, logRangeMsg);
const logFilter = z.object(logFilters).refine(logRange, logRangeMsg);

// Reports & analytics (read only)
const reportQuery = z.object({ period: z.enum(['daily', 'weekly', 'monthly', 'custom']).default('monthly'), date: optYmd, from: optYmd, to: optYmd, limit: z.coerce.number().int().min(1).max(5000).default(200) });

const suspList = page.extend({ q, status: z.enum(['all', 'open', 'reviewed', 'dismissed', 'actioned']).default('open'), type: z.enum(['all', 'repeated_scan', 'duplicate_transaction', 'unusual_activity', 'multi_device']).default('all'), severity: z.enum(['all', 'low', 'medium', 'high']).default('all') });
const suspNote = z.object({ note: z.string().trim().min(3, 'Write a note (at least 3 characters)').max(2000) });
const suspReview = z.object({ decision: z.enum(['reviewed', 'dismissed']), note: z.string().trim().min(5, 'Record your investigation notes (at least 5 characters)').max(2000) });
const suspAction = z.object({ action: z.enum(['flag_student', 'deactivate_qr', 'deactivate_driver']), note: z.string().trim().min(5, 'Say why you are taking this action (at least 5 characters)').max(255) });
const suspDetect = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).default({ hours: 24 });

const settingsPatch = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 40, 'Nothing to update');
const backupList = page.extend({ status: z.enum(['all', 'running', 'completed', 'failed', 'deleted']).default('all') });
const retentionRun = z.object({ dryRun: z.boolean().default(false), password: z.string().max(200).optional() }).default({ dryRun: false });
const historyList = page.extend({ q, studentId: z.string().trim().max(32).optional(), event: z.enum(['all', 'application_approved', 'application_rejected', 'application_reopened', 'document_verified', 'document_rejected', 'correction_approved', 'correction_rejected', 'renewal_approved', 'renewal_rejected', 'qr_replacement_approved', 'qr_replacement_rejected']).default('all') });
const appMonitor = page.extend({ q, status: z.enum(['all', 'pending', 'verified', 'rejected']).default('pending') });

/* ---------- fares and discounts ---------- */
const money = (label) => z.coerce.number({ message: `${label} must be a number` }).min(0.01, `${label} must be more than 0`).max(9999.99, `${label} is too large`)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, `${label} can have at most 2 decimal places`);
const percent = z.coerce.number({ message: 'Discount percentage must be a number' }).min(0, 'Discount percentage cannot be negative').max(100, 'Discount percentage cannot be more than 100')
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Discount percentage can have at most 2 decimal places');
const optRoute = z.union([z.coerce.number().int().positive(), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v == null ? null : v));
const password = z.string().min(1, 'Your password is required to authorize this change').max(200);
const fareRules = (o, ctx) => {
  if (o.effectiveUntil && o.effectiveUntil < o.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveUntil'], message: 'The expiration date cannot be before the start date' });
  if (o.discountStart && o.discountEnd && o.discountEnd < o.discountStart) ctx.addIssue({ code: 'custom', path: ['discountEnd'], message: 'The discount end date cannot be before its start date' });
};
const fareShape = { routeId: optRoute, regularFare: money('Regular fare'), discountPercent: percent, effectiveFrom: ymd, effectiveUntil: optYmd, discountStart: optYmd, discountEnd: optYmd, notes: optText(255), password };
const fareUpdate = z.object(fareShape).superRefine(fareRules);
const fareCreate = z.object({ ...fareShape, isActive: z.boolean().default(true), discountActive: z.boolean().default(true) }).superRefine(fareRules);
const fareList = page.extend({ route: z.string().trim().max(12).optional(), state: z.enum(['all', 'current', 'upcoming', 'expired', 'inactive']).default('all'), q });
/* Driver self-service (signed-in driver only; the driver's id always comes from the session, never from the request). */
const driverDocUpload = z.object({ type: z.enum(['license', 'government_id']), documentNo: optText(60), expiresOn: optYmd });
const driverInboxQuery = page.extend({
  filter: z.enum(['all', 'unread', 'read']).default('all'),
  category: z.enum(['all', 'account_status', 'eligibility_expiry', 'qr_expiry', 'announcement', 'refund', 'general']).default('all')
});
const driverTxnList = page.extend({ q, status: z.enum(['all', 'completed', 'cancelled', 'refunded']).default('all'), from: ymd.optional(), to: ymd.optional() });
const driverTripList = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) });

const fareToggle = z.object({ active: z.boolean(), password });
const fareCalc = z.object({ routeId: optRoute, date: optYmd });

module.exports = {
  driverDocUpload, driverInboxQuery, driverTxnList, driverTripList,
  fareCreate, fareUpdate, fareList, fareToggle, fareCalc,
  page, id, vehicleCreate, vehicleUpdate, vehicleList, vehicleStatus, driverRef, routeCreate, routeUpdate, routeList, routeStatus, vehicleRef,
  tripCreate, tripUpdate, tripList, tripComplete, tripCancel, tripMonitor, docUpload, docList, docReview, driverStatusList,
  deviceRegister, deviceList, deviceStatus, deviceRemove, deviceHistory, annCreate, annUpdate, annList, notifList, notifSend,
  refundList, refundCreate, refundDecide, txnList, txnCancel, cancelList, txnMgmtList, txnMgmtFilter, suspList, suspNote, suspReview, suspAction, suspDetect,
  settingsPatch, backupList, retentionRun, historyList, appMonitor, logList, logFilter, reportQuery
};
