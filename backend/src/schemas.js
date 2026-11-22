'use strict';
const { z } = require('zod');

const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

const trimmed = (max, label) => z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);
// School IDs end up inside QR payloads ("{id}::v{n}", "TRANSITPASS|{id}") so those separators are not allowed.
const schoolId = z.string().trim().min(1, 'School ID is required').max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9\-_./]*$/, 'School ID may only contain letters, numbers and - _ . /');
const email = z.string().trim().toLowerCase().max(190).email('Enter a valid email address');
const descriptor = z.array(z.number().finite().min(-10).max(10)).length(128, 'Face descriptor must have 128 values');
const facePhoto = z.string().max(300_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Face photo must be a base64 image data URL');
const validUntil = trimmed(40, 'Validity date');

// username OR email (drivers can use either)
 // portal "admin" = the administrator sign-in page: only administrator accounts may sign in there.
 const login = z.object({ username: z.string().trim().min(1).max(190), password: z.string().min(1).max(200), portal: z.enum(['admin', 'driver']).optional() });

// Admin dashboard lists
const dashActivities = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10), offset: z.coerce.number().int().min(0).max(500).default(0) });
const dashTransactions = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(8),
  offset: z.coerce.number().int().min(0).default(0)
});

const accountUpdate = z.object({
  name: trimmed(120, 'Name'),
  email,
  username: z.string().trim().min(3, 'Username must be at least 3 characters').max(60)
    .regex(/^[A-Za-z0-9._-]+$/, 'Username may only contain letters, numbers and . _ -'),
  phone: z.string().trim().max(40, 'Phone number is too long').regex(/^[0-9 +()\-.]*$/, 'Phone number may only contain digits, spaces and + ( ) - .')
}).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const passwordChange = z.object({
  current: z.string().min(1, 'Current password is required'),
  new: z.string().min(8, 'New password must be at least 8 characters').max(200),
  confirm: z.string()
}).refine((o) => o.new === o.confirm, { message: 'New passwords do not match', path: ['confirm'] });

const studentBase = {
  name: trimmed(120, 'Name'),
  school: trimmed(160, 'School'),
  program: trimmed(160, 'Program'),
  level: trimmed(60, 'Level'),
  email,
  schoolId,
  phone: z.string().trim().max(40).optional(),
  validUntil: validUntil.optional()
};

// A student creating their own account. No validUntil / status here: new accounts always start "pending".
// campus / section are optional for plain JSON clients (older callers) and required by the portal form (multipart), see studentRegisterStrict.
const registerShape = {
  name: studentBase.name,
  school: studentBase.school,
  program: studentBase.program,
  level: studentBase.level,
  email,
  schoolId,
  phone: studentBase.phone,
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long'),
  confirm: z.string()
};
const passwordsMatch = (o) => o.password === o.confirm;
const studentRegister = z.object({ ...registerShape, campus: trimmed(120, 'Campus').optional(), section: trimmed(60, 'Section').optional() })
  .refine(passwordsMatch, { message: 'Passwords do not match', path: ['confirm'] });
const studentRegisterStrict = z.object({ ...registerShape, campus: trimmed(120, 'Campus'), section: trimmed(60, 'Section') })
  .refine(passwordsMatch, { message: 'Passwords do not match', path: ['confirm'] });

// Sign in with the School ID OR the email address. "schoolId" is kept as the field name so older callers keep working.
const studentLogin = z.object({
  schoolId: z.string().trim().min(1).max(190).optional(),
  identifier: z.string().trim().min(1).max(190).optional(),
  password: z.string().min(1, 'Password is required').max(200)
}).refine((o) => o.schoolId || o.identifier, { message: 'Student ID or email is required', path: ['schoolId'] });

const studentForgot = z.object({ identifier: z.string().trim().min(1, 'Enter your Student ID or email').max(190) });
const studentReset = z.object({
  token: z.string().trim().min(20).max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long'),
  confirm: z.string()
}).refine(passwordsMatch, { message: 'Passwords do not match', path: ['confirm'] });

// --- signed-in student ---
const phone = z.string().trim().regex(/^[0-9+()\-\s]{7,40}$/, 'Enter a valid contact number (digits, spaces, + - ( ) only)');
const studentProfileUpdate = z.object({ phone });
const studentPasswordChange = z.object({
  current: z.string().min(1, 'Current password is required').max(200),
  new: z.string().min(8, 'New password must be at least 8 characters').max(72, 'Password is too long'),
  confirm: z.string()
}).refine((o) => o.new === o.confirm, { message: 'New passwords do not match', path: ['confirm'] });
const studentEmailChange = z.object({ email, password: z.string().min(1, 'Enter your password to confirm').max(200) });

// Enrollment details are only changed by the registrar, so a student asks for a correction.
const CORRECTION_FIELDS = ['name', 'schoolId', 'school', 'campus', 'program', 'level', 'section'];
const studentRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('correction'),
    field: z.enum(CORRECTION_FIELDS),
    value: z.string().trim().min(1, 'Enter the correct value').max(160),
    reason: z.string().trim().min(5, 'Tell the registrar why (at least 5 characters)').max(500)
  }),
  z.object({ type: z.literal('renewal'), reason: z.string().trim().max(500).optional() }),
  z.object({ type: z.literal('qr_replacement'), reason: z.string().trim().min(5, 'Tell the registrar why (at least 5 characters)').max(500) })
]);
const studentQrLost = z.object({ note: z.string().trim().max(500).optional() }).default({});

const studentRefundCreate = z.object({ scanId: z.coerce.number().int().positive(), amount: z.coerce.number().positive().max(100000).optional(), reason: z.string().trim().min(5, 'Tell us why you are asking for a refund (at least 5 characters)').max(500) });
const studentRefundList = page.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all') });

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD');
const studentTransactions = page.extend({ q: z.string().trim().max(100).optional(), from: dateOnly.optional(), to: dateOnly.optional(), status: z.enum(['all', 'completed', 'cancelled', 'refunded', 'pending']).default('all') });
const studentNotifications = page.extend({ filter: z.enum(['all', 'unread']).default('all') });

const studentCreate = z.object({
  ...studentBase,
  faceDescriptor: descriptor.nullish(),
  facePhoto: facePhoto.nullish()
});

// PATCH: omit a field to keep it. faceDescriptor: array = enroll/replace, null = remove face.
const studentUpdate = z.object({
  ...studentBase,
  faceDescriptor: descriptor.nullable(),
  facePhoto: facePhoto.nullable()
}).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const studentList = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'active', 'pending', 'expired', 'flagged', 'rejected']).default('all'),
  discount: z.enum(['all', 'eligible', 'ineligible']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0)
});

const ACTIONS = ['approve', 'reinstate', 'flag', 'revoke', 'activate-qr', 'deactivate-qr',
  'regenerate-qr', 'mark-eligible', 'mark-ineligible', 'set-validity'];
const studentAction = z.object({ validUntil: validUntil.optional(), reason: z.string().trim().min(3).max(255).optional(), note: z.string().trim().max(255).optional() }).default({});


const CODES = ['VERIFIED_STUDENT', 'PENDING_VERIFICATION', 'INVALID_QR', 'REVOKED_QR', 'EXPIRED_QR', 'REJECTED_STUDENT', 'FLAGGED_REVIEW'];
const scanList = page.extend({
  q: z.string().trim().max(100).optional(),
  result: z.enum(['all', 'granted', 'review', 'denied']).default('all'),
  code: z.enum(['all', ...CODES]).default('all'),
  method: z.enum(['all', 'qr', 'manual']).default('all'),
  driverId: z.coerce.number().int().positive().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});
const feedQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const emailList = page.extend({ q: z.string().trim().max(100).optional() });

const scannerScan = z.object({ code: z.string().trim().min(1, 'Nothing was scanned').max(500) });
const scannerLookup = z.object({ schoolId: z.string().trim().min(1, 'Enter a School ID').max(40) });

// A batch of checks a driver recorded while offline. clientId is generated on the device and is the idempotency key:
// sending the same item again (after a lost reply, for example) must never create a second transaction.
const scannerSyncItem = z.object({
  clientId: z.string().trim().min(8, 'Offline item id is required').max(64).regex(/^[A-Za-z0-9._:-]+$/, 'Offline item id is not valid'),
  method: z.enum(['qr', 'manual']),
  value: z.string().trim().min(1, 'Nothing was scanned').max(500),
  scannedAt: z.coerce.date()
});
const scannerSync = z.object({ items: z.array(scannerSyncItem).min(1, 'Nothing to synchronize').max(50, 'Send at most 50 checks at a time') });

const OPERATOR_STATUS = z.enum(['Cleared', 'For review', 'Pending docs']);
const operatorCreate = z.object({
  name: trimmed(120, 'Name'),
  trips: z.number().int().min(0).default(0),
  discount: z.number().min(0).max(1e10).default(0),
  status: OPERATOR_STATUS.default('Pending docs')
});
const operatorUpdate = operatorCreate.partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const username = z.string().trim().min(3, 'Username must be at least 3 characters').max(60).regex(/^[A-Za-z0-9._-]+$/, 'Username may only contain letters, numbers and . _ -');
const driverCreate = z.object({
  name: trimmed(120, 'Name'), username, email,
  phone: z.string().trim().max(40).optional(), unit: z.string().trim().max(60).optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long'),
  status: z.enum(['active', 'pending']).default('active')
});
const driverUpdate = z.object({
  name: trimmed(120, 'Name'), username, email,
  phone: z.string().trim().max(40), unit: z.string().trim().max(60)
}).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const driverList = page.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'pending', 'active', 'inactive']).default('all') });
const driverPassword = z.object({ password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password is too long') });

const verificationList = page.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'pending', 'verified', 'rejected']).default('pending') });
const verificationApprove = z.object({ note: z.string().trim().max(255).optional() }).default({});
// Student management: document review + correction requests
const documentReview = z.object({
  decision: z.enum(['verified', 'rejected']),
  reason: z.string().trim().max(255).optional()
}).refine((o) => o.decision !== 'rejected' || (o.reason && o.reason.length >= 3), { message: 'Give a reason (at least 3 characters)', path: ['reason'] });
const correctionList = page.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'pending', 'approved', 'rejected']).default('pending') });
const renewalList = page.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'pending', 'approved', 'rejected']).default('pending') });
const qrReplacementList = page.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['all', 'pending', 'approved', 'rejected']).default('pending') });
const correctionApprove = z.object({ note: z.string().trim().max(255).optional() }).default({});
const correctionReject = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(255) });
const requestApprove = z.object({ note: z.string().trim().max(255).optional() }).default({});
const requestReject = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(255) });
const verificationReject = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(255) });

const qrList = page.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'active', 'revoked', 'expired']).default('all'),
  studentId: z.string().trim().max(32).optional()
});
const qrRevoke = z.object({ reason: z.string().trim().max(255).optional() }).default({});
const dailyQuery = z.object({ days: z.coerce.number().int().min(1).max(60).default(14), driverId: z.coerce.number().int().positive().optional() });

module.exports = {
  driverCreate, driverUpdate, driverList, driverPassword, verificationList, verificationApprove, verificationReject, documentReview, correctionList, correctionApprove, correctionReject, qrList, qrRevoke, dailyQuery, scannerScan, scannerLookup, scannerSync,
  login, dashActivities, dashTransactions, accountUpdate, passwordChange, studentRegister, studentRegisterStrict, studentLogin, studentForgot, studentReset, studentProfileUpdate,
  studentPasswordChange, studentEmailChange, studentRequest, studentQrLost, studentRefundCreate, studentRefundList, studentTransactions, studentNotifications, CORRECTION_FIELDS, studentCreate, studentUpdate, studentList, studentAction, ACTIONS,
  scanList, feedQuery, emailList, operatorCreate, operatorUpdate, page, correctionList, renewalList, qrReplacementList, correctionApprove, correctionReject, requestApprove, requestReject, verificationReject
};
