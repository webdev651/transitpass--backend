'use strict';
/* Dependency-free PDF 1.4 generator used by the admin report export.
   Draws text and simple tables onto A4 pages, then serializes a real PDF.
   No fonts, images or external packages are bundled; Helvetica is a standard
   PDF font every viewer renders natively. */

const enc = new TextEncoder();

const PAGE_W = 595, PAGE_H = 842, M = 40; // A4 points, 40pt margin
const FOOTER_Y = PAGE_H - 30;

function escPdf(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}
function pdfStr(s) { return '(' + escPdf(s) + ')'; }
function num(n) { return Number.isFinite(n) ? String(n) : '0'; }

/* Approximate width of a string rendered in Helvetica at `size` points (average glyph ~0.5em). */
function textWidth(s, size) { return String(s).length * size * 0.52; }

/* Wrap `text` so no line exceeds `maxWidth` points at `size`. Honors explicit newlines. */
function wrap(text, maxWidth, size) {
  const out = [];
  for (const chunk of String(text).split('\n')) {
    if (textWidth(chunk, size) <= maxWidth || chunk.length === 0) { out.push(chunk); continue; }
    const words = chunk.split(' ');
    let line = '';
    for (const w of words) {
      const trial = (line ? line + ' ' : '') + w;
      if (textWidth(trial, size) <= maxWidth) line = trial;
      else { if (line) out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

class PdfPage {
  constructor() { this.ops = []; }
  text(x, y, size, s, font = 'Helvetica') {
    this.ops.push(`BT /${font} ${num(size)} Tf ${num(x)} ${num(y)} Td ${pdfStr(s)} Tj ET`);
  }
  rect(x, y, w, h, stroke) {
    this.ops.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${stroke ? 'S' : 'f'}`);
  }
  line(x1, y1, x2, y2) {
    this.ops.push(`${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  }
}

class PdfDoc {
  constructor() { this.pages = [new PdfPage()]; this.pageCount = () => this.pages.length; }
  cur() { return this.pages[this.pages.length - 1]; }
  newPage() { this.pages.push(new PdfPage()); }
  footer(i, total) {
    const p = this.pages[i - 1];
    p.text(M, FOOTER_Y, 7, `TransitPass · Page ${i} of ${total}`, 'Helvetica');
  }
  buffer(total) {
    // stamp page numbers (footer text at fixed bottom margin does not reflow content)
    for (let i = 1; i <= total; i++) this.footer(i, total);
    const encBuf = (s) => enc.encode(s);
    const parts = []; const offsets = []; let len = 0;
    const push = (b) => { const u = typeof b === 'string' ? encBuf(b) : b; parts.push(u); len += u.length; };
    const obj = (n, body, stream) => {
      offsets[n] = len; push(`${n} 0 obj\n${body}\n`);
      if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
      push('endobj\n');
    };
    const pageRefs = [];
    const fontObj = 3; const pageObjBase = 4; const contentBase = pageObjBase + total;
    push('%PDF-1.4\n');
    obj(1, `<< /Type /Catalog /Pages 2 0 >>`);
    const kids = pageRefs.map((r, i) => `${r} 0 R`).join(' ');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`);
    obj(fontObj, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
    let next = pageObjBase;
    for (let i = 0; i < total; i++) {
      pageRefs.push(next);
      const contentObj = contentBase + i;
      obj(next++, `<< /Type /Page /Parent 2 0 >> /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
      obj(contentObj, `<< /Length ${encBuf(this.pages[i].ops.join('\n')).length} >>`, this.pages[i].ops.join('\n'));
    }
    const xref = len;
    let tail = `xref\n0 ${next}\n0000000000 65535 f \n`;
    for (let n = 1; n < next; n++) tail += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    tail += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    push(tail);
    return new Uint8Array(parts.reduce((a, b) => a.concat(Array.from(b)), []));
  }
}

module.exports = { PdfDoc, PAGE_W, PAGE_H, M, wrap, textWidth };
