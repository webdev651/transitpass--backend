# TransitPass Backend

REST API for the QR-based student transportation discount system (the `transitpass-frontend` prototype).
Node.js · Express 5 · MySQL 8 / MariaDB · JWT auth.

It replaces the prototype's `localStorage` "mock backend": students, scan history, the live feed, the email log,
the admin account, dashboard KPIs, the weekly report and the operator ledger are all served from MySQL, and the
verification decision logic (QR → registry → face check) runs on the server.

## Quick start

```bash
cp .env.example .env         # set DB_USER / DB_PASSWORD (skip if your MySQL is root with no password)
npm install
npm start                    # that's it. It creates the database, the tables and the driver account by itself.
```

**Admin login:** `admin` / `admin1234` (created the first time the server starts when there are no staff accounts; change it with `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`, or from My Account). Drivers are then registered by an administrator on the **Drivers** page and sign in at the same `/admin-login.html` with their own username (or email) and password. An existing database keeps its current account, which becomes an administrator.
Students don't need seeding: they create their own account on the student sign-up page.
`npm run seed:demo` is **optional** and only loads sample students, scans and notifications.
In production `JWT_SECRET` (≥ 32 chars) and `ADMIN_PASSWORD` are required — the server refuses to start without them.

### Test on your phone

`npm start` listens on your whole network and prints the address to open, for example:

```
TransitPass is running (development)
  This computer: http://localhost:3000
  On your phone: http://192.168.1.23:3000   (same Wi-Fi)
  Admin login:   admin / admin1234
```

1. Put the phone on the **same Wi-Fi** as the computer and open the "On your phone" address.
2. If it doesn't load, allow Node.js through the computer's firewall (Windows asks the first time: tick "Private networks").
3. The camera (QR scan, face) only works on `https://` or `localhost`, so on `http://192.168…` the phone can't open the camera. Typing a School ID still works. On Android Chrome you can allow it for testing at `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (add the address).
4. All data lives in MySQL, so an account made on the phone is visible on the computer. Only the sign-in token is kept in the browser.
5. To keep it on this computer only, set `HOST=127.0.0.1` in `.env`.

To serve the static frontend from the same Express app (no CORS needed, camera works on `localhost`), set
`FRONTEND_DIR=../frontend` (the default in `.env.example`). Otherwise run the frontend separately and set `CORS_ORIGIN`
to its origin (e.g. `http://localhost:8000`).

## Tests

```bash
# needs a MySQL/MariaDB user that can create/drop in a database whose name ends in _test (it is wiped each test)
TEST_DB_USER=... TEST_DB_PASSWORD=... npm test        # TEST_DB_NAME defaults to transitpass_test
```
The integration suite covers auth and roles, the registry lifecycle, student verification, QR generation, all six scan results, scan logging, driver isolation, concurrency, reporting and offline synchronization.

## Conventions

- All routes are under `/api` and need `Authorization: Bearer <token>` except `GET /api/health` and `POST /api/auth/login`.
- JSON in, JSON out. Errors: `{ "error": "message", "details"?: [...] }` — 400 validation, 401 auth, 404, 409 conflict/invalid state.
- Field names match the frontend's student record (`schoolId`, `qrActive`, `qrVersion`, `faceEnrolled`, `discountEligible`, …).
- Timestamps: ISO `scannedAt`/`sentAt` plus pre-formatted `date` / `time` / `dateWithDay` in `APP_TIMEZONE` (default `Asia/Manila`), in the same format the UI already shows ("05 Aug 2026", "07:36:44").
- **Face descriptors are never returned** by any endpoint — matching happens server-side. `facePhoto` (small JPEG thumbnail) is returned.

## Endpoints

### Auth & account
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{token, admin}`. Rate-limited (10 failed attempts / 15 min / IP). |
| GET | `/api/auth/me` | Current admin. |
| GET | `/api/admin/account` | Manage Admin Account page. |
| PATCH | `/api/admin/account` | `{name?, email?, username?}` → `{admin, token}`. |
| POST | `/api/admin/account/password` | `{current, new, confirm}` (min 8 chars). Signs out every other session; returns a fresh `token`. |

### Student portal (student sign-up and login)

Two kinds of people use the API, and each has their own login:

| Who | Signs in at | Can create their own account? |
|---|---|---|
| **Student** | `POST /api/student-portal/login` (School ID + password) | **Yes**, `POST /api/student-portal/register` |
| **Driver / Administrator** | `POST /api/auth/login` (username **or email** + password) | No. The first admin is created on first start; drivers are registered by an admin |

Every token carries a `role` (`student`, `admin` or `driver`) that is re-checked against the database on every request, so a student token is rejected on staff routes, a driver token on admin routes, and a deactivated account loses access immediately.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/student-portal/register` | `{name, school, program, level, email, schoolId, phone?, password, confirm}` → `201 {student, message}` (no token). The account starts with verification status **pending**. The student can sign in to see their status, but cannot generate a QR code until an admin verifies them. Password: 8 to 72 characters. 409 if the School ID or email is taken. Limited to 20 sign-ups / hour / IP. |
| POST | `/api/student-portal/login` | `{schoolId, password}` → `{token, student}`. Same error for a wrong password and an unknown School ID. Rate-limited like the driver login. |
| GET | `/api/student-portal/me` | The signed-in student (needs the student token). |
| GET | `/api/student-portal/me/scans` | `?limit=&offset=` → `{items, total}`: only that student's own scans. |
| GET | `/api/student-portal/me/qr` | `{qr, canGenerate, reason}`. `qr.payload` is the text to encode (`TP1.<random token>`), with `generatedAt`, `generatedBy`, `expiresAt`. |
| POST | `/api/student-portal/me/qr` | Generate. 403 unless the student is **verified and active**; 409 if an active code already exists. |
| POST | `/api/student-portal/me/qr/regenerate` | Revokes the active code and issues a new one. |
| POST | `/api/student-portal/me/qr/revoke` | Revokes the active code. |
| GET | `/api/student-portal/me/qr/history` | Their codes (status and dates only, no tokens). |

How it works, in short:
1. `register` hashes the password with bcrypt and saves the student with `status = pending` (the plain password is never stored).
2. `login` finds the student by School ID, compares the password with the saved hash, and returns a token.
3. The student sends that token as `Authorization: Bearer <token>` on `/me` and `/me/scans`.

Code: `src/routes/studentPortal.js` (the 4 endpoints), `src/middleware/auth.js` (`requireStudent`), `src/schemas.js` (`studentRegister`, `studentLogin`).

### Student registry
| Method | Path | Notes |
|---|---|---|
| GET | `/api/students` | `?q=&status=all\|active\|pending\|expired\|flagged&discount=all\|eligible\|ineligible&limit=&offset=` → `{items, total}` |
| GET | `/api/students/stats` | `{total, pending, flagged, ineligible}` for the registry stat cards. |
| POST | `/api/students` | Issues an **active** pass (like the registry's Add form). `{name, school, program, level, email, schoolId, phone?, validUntil?, faceDescriptor?, facePhoto?}` |
| GET / PATCH / DELETE | `/api/students/:id` | PATCH is partial. `faceDescriptor`: array = enroll/replace, `null` = remove face, omitted = keep. DELETE keeps the scan history (student link is nulled). |
| POST | `/api/students/:id/actions/:action` | `approve` (pending) · `reinstate` (flagged) · `flag` (active) · `revoke` · `activate-qr` · `deactivate-qr` · `regenerate-qr` · `mark-eligible` · `mark-ineligible` · `set-validity` (`{validUntil}`). Invalid transitions → 409. Each sends the same notification text the UI used. |
| GET | `/api/students/:id/qr` | `{payload: "2023-1182::v2", qrActive, qrVersion}` — encode `payload` client-side. |
| POST | `/api/students/:id/email-qr` | Logs / sends the "Send QR to Gmail" notification. |
| GET | `/api/students/:id/scans` | That student's history. |

### Scanner (administrators and drivers)

Every scan is checked against MySQL and **logged with the authenticated account that made it**, including failed ones. The HTTP status is 200 for every outcome; read `code`.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/scanner/scan` | `{code}` | `code` = the raw decoded QR text (`TP1.<token>`). |
| POST | `/api/scanner/lookup` | `{schoolId}` | Manual fallback. Uses that student's newest QR record and applies the same checks. |
| POST | `/api/scanner/sync` | `{items:[{clientId, method:"qr"\|"manual", value, scannedAt}]}` (max 50) | A driver's offline queue. `clientId` is the device's idempotency key: replaying the same item returns the original row with `duplicate:true` and never charges twice. Always 200; `results[]` reports `ok`, `code`, `reference`, or a per-item `error`. Checks older than 7 days or with a future timestamp are refused; the rest of the batch is still saved. |

Response: `{code, label, result, ok, reason, student, discountStatus, fare, scan, duplicate}`. `student` is limited to name, School ID, school, program and level (no email, phone or photo) and is `null` when nobody was identified.

Offline checks are verified and priced by the server when they sync, exactly like an online scan; `scanned_at` stays the time the driver recorded the ride, `offline` is set, and `synced_at` records when the server accepted it. The unique key `(scanned_by, client_txn_id)` is what makes retries safe.

Checks, in order: QR exists → token valid → student registered → identity verified → student approved/eligible → QR active (not revoked, not expired).

| `code` | Meaning |
|---|---|
| `VERIFIED_STUDENT` | Valid QR and approved student |
| `PENDING_VERIFICATION` | Student not verified yet |
| `INVALID_QR` | Unknown token, not a TransitPass code, or unknown School ID |
| `REVOKED_QR` | Deactivated or replaced |
| `EXPIRED_QR` | Past `expires_at` (or the student's pass expired) |
| `REJECTED_STUDENT` | Verification was rejected |
| `FLAGGED_REVIEW` | Admin flagged the pass (kept from the original terminal; full fare) |

Old `{schoolId}::v{n}` codes no longer work (they were unsigned and carried a School ID). The face-matching endpoints (`/api/verify/*`) were retired with the old terminal; face *enrollment* data is untouched.

### Driver dashboard (role `driver` only; always the caller's own data)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/driver/me` | Profile + `stats: {today, allTime}` (`total`, `verified`, `rejected`, `review`). |
| GET | `/api/driver/stats` | Same stats. |
| GET | `/api/driver/scans` | Own history. Filters `q`, `result`, `code`, `method`, `from`, `to`. A `driverId` in the URL is ignored. |
| GET | `/api/driver/scans/daily?days=14` | Own per-day totals. |

### Administrator management (role `admin` only)

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/admin/drivers` | List (`q`, `status`) / register `{name, username, email, password, phone?, unit?, status?: active\|pending}`. bcrypt-hashed. |
| PATCH | `/api/admin/drivers/:id` | Edit profile. |
| POST | `/api/admin/drivers/:id/actions/:action` | `approve` \| `activate` \| `deactivate` (deactivating signs the driver out at once). |
| POST | `/api/admin/drivers/:id/password` | `{password}` reset; signs the driver out everywhere. |
| GET | `/api/admin/verifications` | `?status=pending\|verified\|rejected\|all&q=` → `{items, total, counts}` |
| POST | `/api/admin/verifications/:studentId/approve` \| `reject` \| `reopen` | `reject` needs `{reason}`; rejecting revokes the student's active QR. `approve` accepts `{note}`. |
| GET | `/api/admin/verifications/:studentId/registrar-check` | Registrar integration hook (`src/lib/registrar.js`); today answers "not connected, check by hand". |
| GET | `/api/admin/qr-codes` | `?q=&status=&studentId=` → who generated each code (`generatedBy`), when, expiry, status, who revoked it. Full tokens are never listed. |
| POST | `/api/admin/qr-codes/:id/revoke` \| `reactivate` | Reactivate only works for a revoked, unexpired code of a verified student with no other active code. |
| GET | `/api/scans` | All scans. Adds filters `driverId`, `code`, `method`. `GET /api/scans/daily?days=&driverId=` gives daily totals. |

### Verification and QR database model

- `student_verifications` (one row per student): `verification_status` pending/verified/rejected, `verified_by`, `verification_date`, `rejection_reason`, `method` (`admin_review`, `admin_issued`, `legacy`; `registrar_db` is reserved). `students.status` mirrors it (verified → active, rejected → rejected).
- `qr_codes`: `student_id`, `qr_token` (192-bit random, unique), `generated_by_type/_student/_admin/_name`, `generated_at`, `status` active/revoked/expired, `expires_at`, `revoked_at/_by/_reason`. At most one active code per student (enforced under a row lock).
- `scans` gained `qr_code_id`, `scanned_value`, `scan_method`, `verification_result`, `driver_name`; `scanned_by` is the authenticated driver's id.
- `admins` holds every staff login and gained `role` (admin/driver), `status` (pending/active/inactive), `phone`, `unit`, `last_login_at`.
- `QR_VALIDITY_DAYS` (default 180) sets how long a code lasts.

### Dashboard, history, reports
| Method | Path | Notes |
|---|---|---|
| GET | `/api/dashboard` | `{kpis:[{label,value,delta,note}], raw, feed}` — today vs yesterday, computed from real scans. |
| GET | `/api/scans` | `?q=&result=&from=&to=&limit=&offset=` → `{items, total, overall}` (all students, newest first). |
| GET | `/api/scans/feed` | `?limit=` latest scans (live feed). |
| GET | `/api/emails` | `?q=&limit=&offset=` notification log. |
| GET | `/api/reports/weekly` | Last 7 days `{day, date, granted, review, denied}`. |
| GET/POST | `/api/operators` | Operator subsidy ledger. |
| PATCH/DELETE | `/api/operators/:id` | `status`: `Cleared` · `For review` · `Pending docs`. |

## Frontend

All pages talk to the API through `js/app.js` (`api()` helper; sign-in token only in `localStorage`). Staff pages call `requireStaff([...roles])`, which sends a driver to `driver-dashboard.html` and an admin to `admin-dashboard.html`.

| Page | Who | Uses |
|---|---|---|
| `admin-login.html` | admin + driver | `POST /auth/login` |
| `admin-dashboard.html`, `admin-verifications.html`, `students.html`, `admin-qr-codes.html`, `admin-drivers.html`, `admin-scan-history.html`, `reports.html`, `verify.html` | admin | `/dashboard`, `/admin/*`, `/students/*`, `/scans*`, `/scanner/*` |
| `driver-dashboard.html`, `driver-history.html` | driver | `/driver/*`, `/scanner/*` (camera scanner in `js/scanner.js`, jsQR bundled) |
| `admin-account.html` | admin + driver | `/admin/account*` |
| `student-register.html`, `student-login.html`, `student-dashboard.html` | student | `/student-portal/*` |

If the frontend is served from a different origin than the API, set `window.TRANSITPASS_API_BASE = "http://host:3000/api"` before `js/app.js` loads and set `CORS_ORIGIN`.

## Configuration notes

- **Fares:** `FULL_FARE=16.25` and `DISCOUNT_RATE=0.20` give the prototype's ₱13.00 discounted fare. A non-eligible student pays ₱16.25 (the prototype showed ₱13.00 for both).
- **Email:** `EMAIL_MODE=log` (default) only records notifications, like the demo. `EMAIL_MODE=smtp` also delivers via SMTP; delivery failures are recorded as `failed` and never fail the request.
- **Passes:** `valid_until` stays free text, as in the UI; nothing auto-expires a pass when the date passes.
- **Operator ledger** is maintained by hand; scans are not attributed to operators.

## Known limitations / before real use

- **Students added by a registrar have no password**, so they cannot use the student login. Only students who register themselves can sign in. There is no "forgot password" or change-password endpoint for students or drivers (an admin resets a driver's password).
- Existing databases: run `npm run migrate` (or just `npm start`, which migrates). It is additive: old students, scans and accounts are kept. Students who were already approved are recorded as verified with method `legacy`; students still pending stay pending. **Existing students have no QR code yet**: they sign in and generate one (or an admin uses *Issue QR code*). Old printed `School ID::v1` QR codes stop working.
- Verification is administrator-assisted. Nothing is verified automatically. `src/lib/registrar.js` is the place to plug in the school's registrar database later.
- The camera needs `https://` or `localhost`; on plain `http://192.168…` a phone falls back to typing a School ID.
- Face enrollment fields still exist in the registry, but the face check is no longer part of scanning.
- Face descriptors and photos are biometric data stored server-side: use HTTPS, restrict DB access, and check data-privacy obligations (e.g. RA 10173) with your school.
- Change the default admin password (`ADMIN_PASSWORD`) and set `JWT_SECRET` before real use.
