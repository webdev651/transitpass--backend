'use strict';
// Pure unit tests for the CSV writer (no database needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../src/lib/csv');

const cols = [{ header: 'Name', value: (r) => r.name }, { header: 'Fare', value: (r) => r.fare }];

test('csv: starts with a UTF-8 byte-order mark, uses CRLF line ends, keeps numbers numeric and quotes text', () => {
  const out = csv.build(cols, [{ name: 'Ana', fare: 13 }, { name: 'Ben', fare: 16.25 }]);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out.slice(1), '"Name","Fare"\r\n"Ana",13\r\n"Ben",16.25\r\n');
});

test('csv: commas, quotes and line breaks inside a cell stay inside that cell', () => {
  const out = csv.build(cols, [{ name: 'Cruz, "Jun"\nJr.', fare: 1 }]);
  assert.ok(out.includes('"Cruz, ""Jun""\nJr.",1'));
});

test('csv: a text cell that Excel would run as a formula is neutralised', () => {
  for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x']) assert.ok(csv.text(evil).startsWith(`"'`), evil);
  assert.equal(csv.text('Ana'), '"Ana"');
  assert.equal(csv.text('—'), '"—"');
});

test('csv: empty and missing values are empty cells; a header-only file is still valid', () => {
  assert.equal(csv.cell(null), '');
  assert.equal(csv.cell(undefined), '');
  assert.equal(csv.build(cols, []).slice(1), '"Name","Fare"\r\n');
});
