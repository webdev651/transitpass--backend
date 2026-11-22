'use strict';
/*
  CSV for Excel. A UTF-8 byte-order mark makes Excel read the peso sign and accented names correctly, rows end in CRLF,
  and every text cell is quoted. A text cell that starts with = + - @ (or a tab / carriage return) would be run as a formula
  when the file is opened in Excel, so a single quote is put in front of it (inside the quotes) and it stays plain text.
*/
const BOM = '\uFEFF';
const FORMULA = /^[=+\-@\t\r]/;

/** One text cell, quoted and made safe. null / undefined -> empty cell. */
function text(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (FORMULA.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One cell. Numbers are written bare so Excel keeps them numeric; everything else is a safe quoted string. */
const cell = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : text(v));

/** columns: [{ header, value(row) }]  ->  the whole file as a string. */
function build(columns, rows) {
  const lines = [columns.map((c) => text(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(c.value(r))).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

module.exports = { build, cell, text, BOM };
