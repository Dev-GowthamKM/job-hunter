#!/usr/bin/env node
// Export a Loom deck to PDF or PowerPoint.
//
// PDF goes through the Chrome already on the machine, printing the deck's own print stylesheet so
// one slide lands on one landscape page.
//
// PPTX is written by hand. A .pptx is a ZIP of XML parts, and the ZIP format is simple enough to
// emit directly, so this stays dependency-free like everything else here. The slides it produces
// are editable text in PowerPoint, Keynote and Google Slides - not pictures of slides, which is
// the whole point of asking for pptx rather than pdf.
//
//   node src/jobs/slides-export.mjs --job=42 --format=pdf
//   node src/jobs/slides-export.mjs --job=42 --format=pptx
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateRawSync, crc32 } from 'node:zlib';
import { ROOT } from '../db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].find((p) => existsSync(p));

const deckDir = (jobId) => join(ROOT, 'data', 'applications', String(jobId), 'loom');

/** The slide data the deck was built from, read back out of the page. */
export function readDeck(jobId) {
  const file = join(deckDir(jobId), 'slides.html');
  if (!existsSync(file)) throw new Error(`No slides for job ${jobId}. Build the packet first.`);
  const html = readFileSync(file, 'utf8');
  const m = /<script type="application\/json" id="deck">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('slides.html has no deck block.');
  return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export function toPdf(jobId) {
  if (!CHROME) throw new Error('No Chrome found; cannot render a PDF.');
  const src = join(deckDir(jobId), 'slides.html');
  const out = join(deckDir(jobId), 'slides.pdf');
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--no-pdf-header-footer',
    '--virtual-time-budget=3000',        // let the webfonts arrive before printing
    `--print-to-pdf=${out}`,
    `file://${src}`,
  ], { stdio: 'ignore', timeout: 90000 });
  if (!existsSync(out)) throw new Error('Chrome produced no PDF.');
  return out;
}

// ---------------------------------------------------------------------------
// PPTX. A ZIP of XML parts, written directly.
// ---------------------------------------------------------------------------

/** Minimal ZIP writer: local headers, then a central directory. Deflate for everything. */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);    // local file header
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // deflate
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x21, 12);         // date (1 Jan 2000, fixed so output is reproducible)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);       // central directory header
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 42);               // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + deflated.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, cdBuf, end]);
}

const xmlEsc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\x1b/g, '');

/** Strip the **bold** markers the deck uses; PowerPoint runs carry weight, not asterisks. */
const plain = (s = '') => String(s).replace(/\*\*(.+?)\*\*/g, '$1');

const EMU = 9144000 / 10;                  // 1/10 inch, the unit everything below is laid out in
const SLIDE_W = 12192000;                  // 13.333in, 16:9
const SLIDE_H = 6858000;

function textBox({ id, name, x, y, w, h, runs, size, color, bold = false, align = 'l' }) {
  const paras = runs.map((line) => `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Helvetica Neue"/></a:rPr><a:t>${xmlEsc(line)}</a:t></a:r></a:p>`).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEsc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

function slideXml(s) {
  const shapes = [];
  let id = 2;
  let y = 8 * EMU;
  const L = 8 * EMU;
  const W = SLIDE_W - 16 * EMU;

  if (s.brand?.name) {
    shapes.push(textBox({ id: id++, name: 'brand', x: L, y, w: W, h: 4 * EMU, runs: [s.brand.name], size: 1400, color: 'F0A04B', bold: true }));
    y += 6 * EMU;
  }
  if (s.kicker) {
    shapes.push(textBox({ id: id++, name: 'kicker', x: L, y, w: W, h: 4 * EMU, runs: [s.kicker.toUpperCase()], size: 1200, color: 'F0A04B', bold: true }));
    y += 5 * EMU;
  }
  if (s.h1) {
    shapes.push(textBox({ id: id++, name: 'h1', x: L, y, w: W, h: 12 * EMU, runs: [plain(s.h1)], size: 4000, color: 'FFFFFF', bold: true }));
    y += 14 * EMU;
  }
  if (s.h2) {
    shapes.push(textBox({ id: id++, name: 'h2', x: L, y, w: W, h: 10 * EMU, runs: [plain(s.h2)], size: 2800, color: 'FFFFFF', bold: true }));
    y += 12 * EMU;
  }
  if (s.big) {
    shapes.push(textBox({ id: id++, name: 'big', x: L, y, w: W, h: 14 * EMU, runs: [plain(s.big)], size: 6600, color: 'F0A04B', bold: true }));
    y += 16 * EMU;
  }
  if (s.bigSub) {
    shapes.push(textBox({ id: id++, name: 'bigSub', x: L, y, w: W, h: 10 * EMU, runs: [plain(s.bigSub)], size: 1600, color: 'B9C7D6' }));
    y += 11 * EMU;
  }
  if (s.lead) {
    shapes.push(textBox({ id: id++, name: 'lead', x: L, y, w: W, h: 10 * EMU, runs: [plain(s.lead)], size: 1800, color: 'B9C7D6' }));
    y += 11 * EMU;
  }
  if (s.list) {
    shapes.push(textBox({ id: id++, name: 'list', x: L, y, w: W, h: 20 * EMU, runs: s.list.map((l) => `•  ${plain(l)}`), size: 1800, color: 'E9F0F7' }));
  }
  if (s.columns) {
    const colW = (W - 4 * EMU) / 2;
    s.columns.forEach((c, i) => {
      const x = L + i * (colW + 4 * EMU);
      shapes.push(textBox({ id: id++, name: `col${i}head`, x, y, w: colW, h: 4 * EMU, runs: [c.head.toUpperCase()], size: 1200, color: i === 0 ? '5EC8C0' : 'F0A04B', bold: true }));
      shapes.push(textBox({ id: id++, name: `col${i}`, x, y: y + 5 * EMU, w: colW, h: 20 * EMU, runs: c.items.map((l) => `•  ${plain(l)}`), size: 1500, color: 'E9F0F7' }));
    });
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="99" name="bg"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${SLIDE_W}" cy="${SLIDE_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="0F1720"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
${shapes.join('')}
</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`;
}

export function toPptx(jobId) {
  const deck = readDeck(jobId);
  const slides = deck.slides || [];
  const n = slides.length;
  const ids = slides.map((_, i) => 256 + i);

  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}
</Types>`],

    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`],

    ['ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${ids[i]}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>
<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
</p:presentation>`],

    ['ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}
</Relationships>`],

    ['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`],

    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`],

    ['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],

    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`],

    ['ppt/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Job Hunter">
<a:themeElements>
<a:clrScheme name="Job Hunter"><a:dk1><a:srgbClr val="0F1720"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="16212E"/></a:dk2><a:lt2><a:srgbClr val="E9F0F7"/></a:lt2><a:accent1><a:srgbClr val="F0A04B"/></a:accent1><a:accent2><a:srgbClr val="5EC8C0"/></a:accent2><a:accent3><a:srgbClr val="6FB3F5"/></a:accent3><a:accent4><a:srgbClr val="4FD1A5"/></a:accent4><a:accent5><a:srgbClr val="F0616D"/></a:accent5><a:accent6><a:srgbClr val="B9C7D6"/></a:accent6><a:hlink><a:srgbClr val="F0A04B"/></a:hlink><a:folHlink><a:srgbClr val="B9C7D6"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Job Hunter"><a:majorFont><a:latin typeface="Helvetica Neue"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Helvetica Neue"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Job Hunter">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>`],
  ];

  slides.forEach((s, i) => {
    files.push([`ppt/slides/slide${i + 1}.xml`, slideXml(s)]);
    files.push([`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`]);
  });

  const out = join(deckDir(jobId), 'slides.pptx');
  writeFileSync(out, zip(files));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('slides-export.mjs')) {
  const id = arg('job');
  const format = (arg('format') || 'pdf').toLowerCase();
  if (!id) { console.error('usage: node src/jobs/slides-export.mjs --job=<id> --format=pdf|pptx'); process.exit(1); }
  const out = format === 'pptx' ? toPptx(id) : toPdf(id);
  console.log(out);
}
