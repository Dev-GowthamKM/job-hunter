#!/usr/bin/env node
// Turns a tailored resume object into HTML and then a PDF, using the copy of Chrome already on the
// machine. No puppeteer, no npm install, no headless browser download.
//
//   node src/jobs/render.mjs <resume.json> <out.pdf>
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { ROOT } from '../db.mjs';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => existsSync(p));

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bullets = (list = []) => (list.length ? `<ul>${list.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '');

/**
 * Two-column layout: identity, contact and skills on a left rail, experience on the right.
 *
 * Two things keep it honest. The columns are CSS grid rather than a table, and the DOM order is
 * header → experience → rail, so an ATS reading the markup gets the work history before the
 * language list regardless of where the eye sees it. And it is built to fit ONE page: the tailorer
 * chooses what earns a place rather than the template growing to fit everything.
 */
export function toHtml(r) {
  const css = readFileSync(join(ROOT, 'templates', 'resume.css'), 'utf8');
  const id = r.identity || {};

  const section = (title, body, cls = '') => (body ? `<section class="${cls}"><h2>${esc(title)}</h2>${body}</section>` : '');

  const contact = [
    ['Email', id.email], ['Phone', id.phone],
    ['LinkedIn', id.linkedin], ['Location', id.location],
  ].filter(([, v]) => v)
    .map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

  // The rail takes flat lists; a nested skills object is flattened so the template never has to
  // care how the tailorer grouped them.
  const skillList = Array.isArray(r.skills) ? r.skills : Object.values(r.skills || {}).flat();
  const expertise = skillList.length
    ? `<ul class="tags">${skillList.slice(0, 12).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';

  const education = (r.education || []).map((e) => `
    <div class="edu">
      <div class="deg">${esc(e.credential)}</div>
      <div class="org">${esc(e.institution || '')}</div>
      ${e.dates || e.sub ? `<div class="meta">${esc([e.dates, e.sub].filter(Boolean).join(' · '))}</div>` : ''}
    </div>`).join('');

  const languages = (id.languages || []).length
    ? `<ul class="tags">${id.languages.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';

  const entry = (e) => `
    <div class="entry">
      <div class="when">${esc(e.dates || '')}</div>
      <div class="what">${esc(e.title)}</div>
      ${e.company || e.sub ? `<div class="org">${esc([e.company, e.sub].filter(Boolean).join(' · '))}</div>` : ''}
      ${(e.bullets || []).length ? `<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    </div>`;

  const experience = (r.experience || []).map(entry).join('');
  const projects = (r.projects || []).map(entry).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(id.name)} — Resume</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@200;400;600;700&display=swap" rel="stylesheet">
<style>${css}</style></head><body>
<div class="sheet">
  <header>
    <h1>${esc(id.name)}</h1>
    ${id.headline ? `<div class="role">${esc(id.headline)}</div>` : ''}
  </header>

  <aside class="rail">
    ${section('Profile', r.summary ? `<p class="summary">${esc(r.summary)}</p>` : '')}
    ${section('Expertise', expertise)}
    ${section('Education', education)}
    ${section('Languages', languages)}
    ${section('Contact', contact, 'contact')}
  </aside>

  <main class="main">
    ${section('Experience', experience)}
    ${section(r.projectsHeading || 'Projects', projects)}
  </main>
</div>
</body></html>`;
}

export function renderPdf(resumeJsonPath, outPdf) {
  if (!CHROME) throw new Error('No Chrome/Chromium found. Install Google Chrome, or render the .html by hand.');
  const resume = JSON.parse(readFileSync(resumeJsonPath, 'utf8'));
  const html = toHtml(resume);
  const htmlPath = outPdf.replace(/\.pdf$/, '.html');
  writeFileSync(htmlPath, html);

  // Chrome cold start is the entire cost of a render: measured between 10 and 270 seconds on the
  // machine this was built on, depending on what else the browser was doing. It is the browser
  // starting, not the page drawing.
  //
  // Two obvious fixes are not fixes, both measured rather than assumed:
  //   - A scratch --user-data-dir. Headless Chrome hangs on its first-run flow with an empty
  //     profile, even with a "First Run" sentinel: 210s, then a timeout.
  //   - Rendering packets concurrently. execFileSync blocks the thread, so the "lanes" take turns.
  //
  // What actually works is rendering fewer times: the character-budget pre-trim below, and
  // writeHtmlOnly() so a batch renders nothing at all until someone opens a packet.
  //
  // The retry is separate: a burst of launches makes macOS refuse the spawn outright, which killed
  // a 57-packet rebuild on its second packet. One pause and another try clears it.
  const launch = () => execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    `--print-to-pdf=${outPdf}`,
    `file://${htmlPath}`,
  ], { stdio: 'ignore', timeout: 90000 });

  try {
    launch();
  } catch (first) {
    execFileSync('/bin/sleep', ['2']);
    try { launch(); } catch { throw new Error(`Chrome failed twice rendering ${outPdf}: ${first.message.slice(0, 80)}`); }
  }

  if (!existsSync(outPdf)) throw new Error('Chrome produced no PDF.');

  // One page is the brief. A PDF has one /Type /Page object per page, so counting them is enough to
  // catch a tailored resume that quietly grew to two.
  const pages = (readFileSync(outPdf).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { html: htmlPath, pdf: outPdf, pages: pages || 1 };
}

/**
 * Render, and if it spills onto a second page, trim and try again.
 *
 * "One page" cannot be a note in an agent prompt and left at that — the tailorer has no way to know
 * how tall its prose renders. So the template enforces it: the least important line goes first
 * (trailing project bullets, then trailing experience bullets, then whole trailing projects), and
 * the loop stops the moment it fits. What survives is what mattered most, which is the same
 * decision a person makes with a one-page limit, just repeatable.
 */

/**
 * Drop the least important lines until the content plausibly fits one page.
 *
 * A character budget rather than a render, because rendering costs a browser launch. Measured
 * against the two-column template: about 2400 characters of JSON is the limit. Anything still over
 * after this is caught by the render loop, which is now rarely needed.
 */
function trimToBudget(r) {
  const trims = [];
  const budget = 2400;
  const weight = (x) => JSON.stringify(x || '').length;
  let over = weight(r.summary) + weight(r.skills)
    + (r.experience || []).reduce((a, e) => a + weight(e), 0)
    + (r.projects || []).reduce((a, p) => a + weight(p), 0) - budget;
  while (over > 0) {
    const lastProject = (r.projects || []).at(-1);
    if (lastProject && (lastProject.bullets || []).length > 1) { over -= weight(lastProject.bullets.pop()); continue; }
    if ((r.projects || []).length > 1) { over -= weight(r.projects.pop()); trims.push('dropped a trailing project'); continue; }
    const longest = (r.experience || []).slice().sort((a, b) => (b.bullets?.length || 0) - (a.bullets?.length || 0))[0];
    if (longest && (longest.bullets || []).length > 2) { over -= weight(longest.bullets.pop()); continue; }
    break;
  }
  return trims;
}

/**
 * Write the resume HTML and the trimmed resume.json, without launching a browser.
 *
 * Chrome is the entire cost of building a packet. Writing the page is instant, so a batch can build
 * everything and leave the PDF for whoever actually opens one. The character-budget pre-trim below
 * runs here too, so the HTML on disk is already the one-page version rather than something that
 * would need re-trimming at render time.
 */
export function writeHtmlOnly(resumeJsonPath, outPdf) {
  const r = JSON.parse(readFileSync(resumeJsonPath, 'utf8'));
  const trims = trimToBudget(r);
  writeFileSync(resumeJsonPath, JSON.stringify(r, null, 2) + '\n');
  const htmlPath = outPdf.replace(/\.pdf$/, '.html');
  writeFileSync(htmlPath, toHtml(r));
  return { html: htmlPath, pdf: outPdf, pages: 0, trims, deferred: true };
}

/** Is there a PDF next to this HTML, and is it current? */
export function pdfIsStale(pdfPath) {
  const htmlPath = pdfPath.replace(/\.pdf$/, '.html');
  if (!existsSync(pdfPath)) return true;
  if (!existsSync(htmlPath)) return false;
  return statSync(htmlPath).mtimeMs > statSync(pdfPath).mtimeMs;
}

export function renderOnePage(resumeJsonPath, outPdf, { maxPasses = 14 } = {}) {
  const original = JSON.parse(readFileSync(resumeJsonPath, 'utf8'));
  let r = JSON.parse(JSON.stringify(original));
  const trims = [];

  trims.push(...trimToBudget(r));

  for (let pass = 0; pass <= maxPasses; pass++) {
    writeFileSync(resumeJsonPath, JSON.stringify(r, null, 2) + '\n');
    const out = renderPdf(resumeJsonPath, outPdf);
    if (out.pages <= 1) return { ...out, trims, passes: pass };

    // Cheapest thing to lose first.
    const lastProject = (r.projects || []).at(-1);
    const longestRole = (r.experience || []).slice().sort((a, b) => (b.bullets?.length || 0) - (a.bullets?.length || 0))[0];

    if (lastProject && (lastProject.bullets || []).length > 1) {
      lastProject.bullets.pop();
      trims.push(`dropped a bullet from project "${lastProject.title}"`);
    } else if (longestRole && (longestRole.bullets || []).length > 2) {
      longestRole.bullets.pop();
      trims.push(`dropped a bullet from "${longestRole.title}"`);
    } else if ((r.projects || []).length > 1) {
      const gone = r.projects.pop();
      trims.push(`dropped the project "${gone.title}"`);
    } else if ((r.skills || []).length > 8) {
      r.skills = Array.isArray(r.skills) ? r.skills.slice(0, -1) : r.skills;
      trims.push('dropped a skill');
    } else if (r.summary && r.summary.length > 120) {
      r.summary = r.summary.replace(/\.[^.]*\.?\s*$/, '.');
      trims.push('shortened the summary');
    } else {
      // Nothing left that is safe to cut automatically. Two pages beats silently deleting a job.
      return { ...out, trims, passes: pass, overflow: true };
    }
  }
  const out = renderPdf(resumeJsonPath, outPdf);
  return { ...out, trims, overflow: out.pages > 1 };
}

if (process.argv[1] && process.argv[1].endsWith('render.mjs')) {
  const [, , src, out] = process.argv;
  if (!src || !out) { console.error('usage: node src/jobs/render.mjs <resume.json> <out.pdf>'); process.exit(1); }
  const r = renderPdf(src, out);
  console.log(`html → ${r.html}\npdf  → ${r.pdf}`);
}
