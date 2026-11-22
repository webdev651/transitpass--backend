'use strict';
const crypto = require('crypto');

// The QR code holds only this random token. No name, School ID or any other personal data is inside it;
// the server looks the token up in the database every time it is scanned.
const PREFIX = 'TP1.';
const TOKEN_RE = /^TP1\.([A-Za-z0-9_-]{32})$/;

const newToken = () => crypto.randomBytes(24).toString('base64url'); // 192 bits -> 32 URL-safe chars
const toPayload = (token) => `${PREFIX}${token}`;
/** Returns the token inside a scanned string, or null when it is not a TransitPass QR payload. */
const parsePayload = (raw) => { const m = TOKEN_RE.exec(String(raw || '').trim()); return m ? m[1] : null; };
/** Short, non-usable preview for admin tables (the full token is never listed). */
const hint = (token) => `${token.slice(0, 6)}…${token.slice(-4)}`;

module.exports = { newToken, toPayload, parsePayload, hint };
