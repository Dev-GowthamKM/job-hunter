#!/usr/bin/env node
// Builds the public demo: docs/, which GitHub Pages serves.
//
//   node src/web/demo/build.mjs
//
// GitHub Pages serves files. It does not run Node and it cannot open a SQLite database, so the
// live dashboard cannot be hosted there - and it should not be, because the live dashboard holds a
// real resume, a real budget and a real phone number.
//
// What this does instead: seeds a scratch database with an invented candidate, starts the REAL
// server against it, and records what every endpoint answered. The demo page is the real
// dashboard with one shim in front of fetch(), replaying those recordings. Filtering and sorting
// on the Jobs tab are re-implemented over the recorded rows so the controls genuinely work; every
// other read is a straight replay, and every write says so instead of pretending.
//
// The consequence worth knowing: if the server's JSON changes shape, the demo changes with it on
// the next build. A hand-written mock would have drifted silently.
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRATCH = join(ROOT, '.demo');
const DATA = join(SCRATCH, 'data');
const CONFIG = join(SCRATCH, 'config');
const OUT = join(ROOT, 'docs');
const PORT = 4399;
const ENV = { ...process.env, DATA_DIR: DATA, CONFIG_DIR: CONFIG, PORT: String(PORT), SHARE: '0' };

const run = (args, label) => {
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', ...args],
    { cwd: ROOT, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) { console.error(`${label} failed:\n${r.stderr || r.stdout}`); process.exit(1); }
  return r.stdout;
};

// ── 1. A throwaway pipeline ────────────────────────────────────────────────────────────────────
console.log('Seeding a scratch pipeline...');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
run(['src/db.mjs', '--init'], 'db init');
run(['src/web/demo/seed.mjs'], 'seed');

// Packets, built by the real builder. Three is enough to show the shape without spending an hour
// in Chrome; the PDF is the slow part and it is the one a recruiter actually opens.
const PACKETS = [1, 2, 3];
for (const id of PACKETS) {
  console.log(`Building packet ${id}...`);
  run(['src/jobs/apply.mjs', 'init', `--job=${id}`], `packet ${id} init`);
  run(['src/jobs/apply.mjs', 'render', `--job=${id}`, '--pdf'], `packet ${id} render`);
  // The deck downloads are a route on the live server. On a static host they have to already
  // exist as files, so they are exported here into the packet the page will link to.
  run(['-e', `const {toPdf,toPptx}=await import('./src/jobs/slides-export.mjs');toPdf(${id});toPptx(${id});`],
      `packet ${id} slides`);
}

// ── 2. Record what the real server answers ─────────────────────────────────────────────────────
console.log('Starting the real server against it...');
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'src/web/server.mjs'],
  { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

const base = `http://127.0.0.1:${PORT}`;
const ready = async () => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/session`); return true; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return false;
};
if (!await ready()) { console.error(`Server never came up.\n${serverErr}`); server.kill(); process.exit(1); }

const snapshot = {};
const record = async (path) => {
  const r = await fetch(base + path);
  snapshot[path] = await r.json();
  return snapshot[path];
};

for (const p of ['/api/session', '/api/overview', '/api/tiers', '/api/tracks', '/api/deeplinks',
                 '/api/config', '/api/profile', '/api/near-miss', '/api/money?month=2026-09']) {
  await record(p);
}
// Every job, unpaginated and unfiltered. The shim filters this client-side, so the demo's controls
// do the same thing the SQL does rather than being decoration.
const all = await (await fetch(`${base}/api/jobs?limit=200&tier=match,stretch,regional,no`)).json();
for (const id of PACKETS) await record(`/api/job/${id}`);

server.kill();
await new Promise((r) => server.on('exit', r));

// ── 3. Write the page ──────────────────────────────────────────────────────────────────────────
console.log('Writing docs/...');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Packet files, so the drawer's links open something real.
for (const id of PACKETS) {
  const src = join(DATA, 'applications', String(id));
  if (existsSync(src)) cpSync(src, join(OUT, 'packet', String(id)), { recursive: true });
}

let html = readFileSync(join(ROOT, 'src', 'web', 'app.html'), 'utf8');

// GitHub Pages serves this from a subpath, so a root-absolute /packet/ link would leave the site.
html = html.replaceAll('href="/packet/${id}/', 'href="packet/${id}/');
// Same for the two deck downloads, which are a server route in the real app and plain files here.
html = html.replaceAll('href="/api/slides/${id}/pdf"', 'href="packet/${id}/loom/slides.pdf"');
html = html.replaceAll('href="/api/slides/${id}/pptx"', 'href="packet/${id}/loom/slides.pptx"');

const shim = `
<script>
// ── DEMO SHIM ──────────────────────────────────────────────────────────────────────────────────
// This file is the real dashboard, built by src/web/demo/build.mjs. The data below was recorded
// from the real server running against an invented candidate and invented jobs. Nothing here is
// anyone's real information.
const DEMO = ${JSON.stringify({ snapshot, jobs: all.rows }, null, 1)};

// jobList() does its filtering in SQL. Re-doing it here is what makes the tier chips, the track
// chips, the salary range and the sort actually work instead of returning the same page every time.
function demoJobs(qs) {
  const q = Object.fromEntries(new URLSearchParams(qs));
  let rows = DEMO.jobs.slice();
  if (q.tier) { const t = q.tier.split(','); rows = rows.filter((r) => t.includes(r.tier)); }
  if (q.track) { const t = q.track.split(','); rows = rows.filter((r) => t.includes(r.track)); }
  if (q.eligibility) rows = rows.filter((r) => r.eligibility === q.eligibility);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.company) rows = rows.filter((r) => (r.company || '').toLowerCase().includes(q.company.toLowerCase()));
  const min = Number(q.salaryMin) || 0, max = Number(q.salaryMax) || 0;
  if (min || max) {
    rows = rows.filter((r) => {
      if (r.salary_min == null) return q.unknownSalary !== '0';
      return (!min || (r.usd_max ?? r.usd_min) >= min) && (!max || r.usd_min <= max);
    });
  } else if (q.unknownSalary === '0') rows = rows.filter((r) => r.salary_min != null);
  rows.sort(q.sort === 'pay' ? (a, b) => (b.usd_max ?? -1) - (a.usd_max ?? -1)
    : q.sort === 'new' ? (a, b) => String(b.posted_at).localeCompare(String(a.posted_at))
    : (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.id - a.id);
  const offset = Number(q.offset) || 0, limit = Number(q.limit) || 60;
  return { total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

const DEMO_WRITE = { ok: false, demo: true,
  error: 'This is the public demo, so it is read-only. Clone the repo to run the real thing.' };

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);
  const reply = (body) => new Response(JSON.stringify(body),
    { status: 200, headers: { 'content-type': 'application/json' } });

  if ((init.method || 'GET').toUpperCase() !== 'GET') {
    // Writes are the one place a demo must not pretend. Recording an approval or a spend as if it
    // had happened would be teaching the page to lie about the only thing this system guards.
    return reply(DEMO_WRITE);
  }
  const [path, qs = ''] = url.split('?');
  if (path === '/api/jobs') return reply(demoJobs(qs));
  const exact = DEMO.snapshot[url] ?? DEMO.snapshot[path];
  if (exact !== undefined) return reply(exact);
  if (path.startsWith('/api/money')) return reply(DEMO.snapshot['/api/money?month=2026-09']);
  return reply({ error: 'Not part of the demo snapshot.', demo: true });
};
</script>
<style>
/* The app's body is a flex row that fills the viewport, so a banner placed inside it becomes a
   third column next to the sidebar. It has to sit outside the flow and the body has to make room
   for it. */
#demobar {
  position: fixed; inset: 0 0 auto 0; z-index: 9999; height: 36px;
  display: flex; gap: 9px; align-items: center; white-space: nowrap; overflow: hidden;
  padding: 0 16px; font: 500 12.5px/36px Inter, system-ui, sans-serif;
  color: #16233a; background: linear-gradient(90deg, #ffd79a, #ffc978);
  border-bottom: 1px solid rgba(0,0,0,.16);
}
#demobar b { font-weight: 700; }
#demobar span { overflow: hidden; text-overflow: ellipsis; }
#demobar a { color: #16233a; margin-left: auto; padding-left: 14px; font-weight: 600; }
body { padding-top: 36px; box-sizing: border-box; }
</style>
`;

// The repo link is read from the git remote, never written by hand. A placeholder like
// OWNER/REPO in a published page is a dead link on the one page meant to be shown to strangers.
const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const repoUrl = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote)?.[1];
if (!repoUrl) console.log('  (no github remote yet, so the page ships without a source link)');

const bar = `
<div id="demobar">
  <b>Demo.</b>
  <span>Invented candidate, invented jobs, read-only. The code is real: every number here came from
  the actual server, recorded at build time.</span>
  ${repoUrl ? `<a href="https://github.com/${repoUrl}">Source on GitHub</a>` : ''}
</div>
`;

html = html.replace('</head>', shim + '</head>');
html = html.replace(/<body([^>]*)>/, (m) => m + bar);
writeFileSync(join(OUT, 'index.html'), html);
// Pages runs Jekyll otherwise, and Jekyll skips files that start with an underscore.
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`docs/index.html written — ${DEMO_SIZE(html)} , ${all.rows.length} jobs, ${PACKETS.length} packets.`);
function DEMO_SIZE(s) { return (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB'; }
