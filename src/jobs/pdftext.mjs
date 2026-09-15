#!/usr/bin/env node
// Text out of a PDF with no dependencies and nothing to install.
//
// This exists because there is no PDF reader on a stock macOS - no pdftotext, no pypdf, no PyObjC -
// and asking the owner to `brew install poppler` before their resume can be read is a bad first
// step. PDFs store text in compressed content streams; this inflates them and reads the
// text-showing operators back out.
//
// Two wrinkles that a naive version gets wrong, both present in the owner's own resume:
//   1. Strings are often UTF-16BE, so every character arrives as a 0x00 high byte plus a low byte.
//   2. Subset fonts renumber their glyphs, typically so that code = character - 29. Read without
//      correcting for that, the resume decodes to "* H Q H U D W L Y H" instead of "Generative".
//
//   node src/jobs/pdftext.mjs <file.pdf>
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * Walk a content stream and return its string literals as byte arrays.
 *
 * Joining on string boundaries does not work: PDFs emit one literal per glyph inside a TJ array so
 * they can kern, so "Generative" arrives as ten separate strings and splitting there puts every
 * character on its own line. Everything in a stream is therefore concatenated, and the space
 * character - which the font carries as its own glyph code - keeps the words apart.
 */
const BREAK = Symbol('break');

function tokens(buf) {
  const out = [];
  let depth = 0, cur = [], word = [];
  const flushWord = () => { if (word.length) { out.push(word); word = []; } };

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];

    if (depth > 0) {
      if (b === 0x5c) {                                  // backslash escape
        const next = buf[i + 1];
        if (next >= 0x30 && next <= 0x37) {              // octal \ddd
          let oct = '', j = i + 1;
          while (j < buf.length && oct.length < 3 && buf[j] >= 0x30 && buf[j] <= 0x37) oct += String.fromCharCode(buf[j++]);
          cur.push(parseInt(oct, 8)); i = j - 1;
        } else { cur.push(next); i++; }
        continue;
      }
      if (b === 0x28) { depth++; cur.push(b); continue; }
      if (b === 0x29) { depth--; if (depth === 0) { word.push(...cur); cur = []; } else cur.push(b); continue; }
      cur.push(b);
      continue;
    }

    if (b === 0x28) { depth = 1; cur = []; continue; }

    // Deliberately NO per-operator line breaking. Design tools emit a positioning operator between
    // every single glyph, so breaking on Td/Tm puts one character on each line. Word spacing is
    // already carried as its own glyph code inside the strings, so continuous joining is both
    // simpler and more faithful; the only real break is the end of a content stream.
  }
  flushWord();
  return out;
}

/** UTF-16BE shows up as a 0x00 in every other slot. */
const isUtf16 = (bytes) => bytes.length >= 4 && bytes.filter((_, i) => i % 2 === 0).every((b) => b === 0);

/**
 * Work out the subset font's glyph offset by assuming the most common code is a space.
 * Resumes are mostly spaces and lowercase letters, so this converges on the right answer without
 * needing to parse the font's /Differences array.
 */
function detectShift(codes) {
  const freq = new Map();
  for (const c of codes) if (c > 0) freq.set(c, (freq.get(c) || 0) + 1);
  if (!freq.size) return 0;
  const [common] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  const shift = 0x20 - common;
  // Only trust it when it actually lands the alphabet in printable range.
  return shift > 0 && shift < 64 ? shift : 0;
}

export function pdfText(path) {
  const buf = readFileSync(path);
  const chunks = [];
  let i = 0;

  while (true) {
    const s = buf.indexOf('stream', i);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start);
    if (e === -1) break;
    i = e + 9;
    let inflated;
    try { inflated = inflateSync(buf.subarray(start, e)); } catch { continue; }
    if (!/T[Jj]/.test(inflated.toString('latin1'))) continue;
    chunks.push(inflated);
  }

  // Collect every glyph code first, so the shift is detected across the whole document rather than
  // per string - a single word is not enough signal.
  const toks = chunks.flatMap((c) => [...tokens(c), BREAK]);
  const decoded = toks.map((t) => (t === BREAK ? BREAK : (isUtf16(t) ? t.filter((_, n) => n % 2 === 1) : t)));
  const shift = detectShift(decoded.filter((t) => t !== BREAK).flat());

  const text = decoded.map((codes) => {
    if (codes === BREAK) return '\n';
    return codes.map((c) => {
      const v = c + shift;
      return v >= 32 && v <= 126 ? String.fromCharCode(v) : '';
    }).join('');
  }).join('');

  return text.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

if (process.argv[1] && process.argv[1].endsWith('pdftext.mjs')) {
  const f = process.argv[2];
  if (!f) { console.error('usage: node src/jobs/pdftext.mjs <file.pdf>'); process.exit(1); }
  console.log(pdfText(f));
}
