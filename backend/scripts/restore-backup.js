'use strict';
/*
  Restores a TransitPass backup (.sql.gz made by the Backups page).

    node scripts/restore-backup.js <backup-file> [--database NAME] [--yes] [--no-safety-backup]

  Without --yes it only checks the file and prints what it would do. With --yes it:
    1. checks the SHA-256 checksum against the .sha256 file next to the backup (when present) and that the file is complete,
    2. takes a safety backup of the CURRENT database first (skip with --no-safety-backup),
    3. drops and recreates every table that is in the backup, and loads its rows.
  STOP the TransitPass server before restoring, so nothing writes while the tables are replaced.
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const config = require('../src/config');
const backups = require('../src/services/backups');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--database');
  const flag = (n) => args.includes(`--${n}`);
  const dbIdx = args.indexOf('--database');
  const database = dbIdx >= 0 ? args[dbIdx + 1] : config.db.database;
  if (!file) { console.error('Usage: node scripts/restore-backup.js <backup-file.sql.gz> [--database NAME] [--yes] [--no-safety-backup]'); process.exit(2); }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) { console.error(`File not found: ${abs}`); process.exit(2); }

  const buf = fs.readFileSync(abs);
  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  const sidecar = `${abs}.sha256`;
  if (fs.existsSync(sidecar)) {
    const expected = fs.readFileSync(sidecar, 'utf8').split(/\s+/)[0];
    if (expected !== sum) { console.error('Checksum mismatch: the backup file is damaged or was changed. Not restoring.'); process.exit(1); }
    console.log('Checksum OK.');
  } else console.log('No .sha256 file next to the backup; skipping the checksum comparison.');
  const text = zlib.gunzipSync(buf).toString('utf8');
  if (!/-- END OF BACKUP: (\d+) tables, (\d+) rows\s*$/.test(text)) { console.error('The backup file is incomplete (end marker missing). Not restoring.'); process.exit(1); }
  const statements = text.split(backups.SEP).filter((s) => s.trim() && !s.trim().startsWith('--'));
  const [, tables, rows] = /-- END OF BACKUP: (\d+) tables, (\d+) rows/.exec(text);
  console.log(`Backup holds ${tables} tables and ${rows} rows (${statements.length} statements). Target database: "${database}".`);
  if (!flag('yes')) { console.log('\nDry run only. Stop the TransitPass server, then run again with --yes to restore.'); return; }

  const { host, port, user, password, ssl } = config.db;
  if (!flag('no-safety-backup') && database === config.db.database) {
    const pool = require('../src/db').createPool();
    try { const b = await backups.run(pool, null, 'manual'); console.log(`Safety backup of the current database saved: ${b.filename}`); }
    catch (e) { console.error(`Could not take a safety backup (${e.message}). Aborting; use --no-safety-backup to skip it.`); await pool.end(); process.exit(1); }
    await pool.end();
  }
  const conn = await mysql.createConnection({ host, port, user, password, ssl, multipleStatements: false, charset: 'utf8mb4' });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${database}\``);
  let n = 0;
  for (const s of statements) { await conn.query(s); n++; }
  await conn.end();
  console.log(`Restored ${n} statements into "${database}". Start TransitPass again.`);
}
main().catch((e) => { console.error('Restore failed:', e.message); process.exit(1); });
