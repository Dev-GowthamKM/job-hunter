#!/usr/bin/env node
// The dashboard. Everything /hunt and /money do from a terminal, done from a browser instead.
//
//   npm run web        then open http://127.0.0.1:4321
//
// Bound to 127.0.0.1 on purpose. This reads the owner's pipeline, his salary expectations and his
// budget; it is not something to expose on a network, and there is no auth because there is no
// listener anyone else can reach.
//
// THE GATE IS STILL THE GATE. /api/approve records the owner's decision and nothing else. There is
// no route here that submits an application, uploads a file, or sends a message. A button in a
// browser is the owner acting, exactly like typing the command; it is not an agent acting.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG, DATA, ROOT, db, now, logEvent, setJobHidden } from '../db.mjs';
import { fmt } from '../jobs/eligibility.mjs';
import { authenticate, createUser, startSession, userForToken, endSession, pruneSessions, tooManyAttempts, recordAttempt, clearAttempts } from '../auth.mjs';
import { profileFor, saveProfile, profileReadiness } from '../profile.mjs';
import { enabledTracks } from '../jobs/tracks.mjs';

const PORT = Number(process.env.PORT || 4321);

// Two modes, and the difference is who can reach it.
//
//   default          127.0.0.1, no login. One person, their own machine.
//   SHARE=1          0.0.0.0, login required on every route. Safe to put behind a tunnel.
//
// SHARE is what makes a link shareable. It is not just a bind address: without a login the
// dashboard hands out the owner's resume, budget, salary expectations and every application
// packet to anyone who has the URL, so the two are deliberately the same switch. You cannot
// open the port without turning on the gate.
const SHARE = process.env.SHARE === '1';
const HOST = SHARE ? '0.0.0.0' : '127.0.0.1';
const D = db();

const cfg = (f) => JSON.parse(readFileSync(join(CONFIG, f), 'utf8'));
const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };

/**
 * Pay, shown in USD so two postings are comparable at a glance.
 * fmt() prints a dollar sign, so handing it 4,408,400 INR produced "$4408k INR" - a number that is
 * wrong twice. Non-USD figures are converted with the same rates the filter uses, and the original
 * is kept alongside so nothing is hidden.
 */
const pay = (r) => {
  if (!r.salary_min) return null;
  const usdMin = r.usd_min ?? r.salary_min;
  const usdMax = r.usd_max ?? r.salary_max ?? r.salary_min;
  const main = usdMin === usdMax ? fmt(usdMin) : `${fmt(usdMin)}–${fmt(usdMax)}`;
  // usd_min / usd_max are ALREADY annualised by the SQL, so appending "/month" to them said
  // $24k-$30k per month for a job paying $2,000 a month. The period belongs to the native figure.
  const nativeNeeded = (r.salary_currency && r.salary_currency !== 'USD') || (r.salary_period && r.salary_period !== 'year');
  const per = r.salary_period === 'month' ? '/mo' : r.salary_period === 'hour' ? '/hr' : '';
  const native = nativeNeeded
    ? ` — ${Math.round(r.salary_min).toLocaleString('en-IN')}–${Math.round(r.salary_max || r.salary_min).toLocaleString('en-IN')} ${r.salary_currency || 'USD'}${per}`
    : '';
  return `${main}/yr${native}`;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The client-acquisition arm. The job dashboard had no idea leads existed, so the whole /ceo side
 *  was invisible here and lived in a second server on another port. One dashboard, three arms. */
function clients() {
  const D = db();
  const all = (sql, ...a) => { try { return D.prepare(sql).all(...a); } catch { return []; } };
  const one = (sql, ...a) => { try { return D.prepare(sql).get(...a); } catch { return null; } };

  const stages = Object.fromEntries(all('SELECT status, COUNT(*) n FROM leads GROUP BY status').map((r) => [r.status, r.n]));
  const ev = Object.fromEntries(all('SELECT kind, COUNT(*) n FROM events GROUP BY kind').map((r) => [r.kind, r.n]));

  // A stage count says where leads are NOW; it reads as "0 researched" the moment they move on.
  // The funnel wants how many have EVER reached each stage, which is what the event log records.
  const found = Object.values(stages).reduce((a, b) => a + b, 0);
  const funnel = [
    { key: 'found',      n: found,                                     note: 'businesses the scout pulled in' },
    { key: 'qualified',  n: (ev.qualified ?? 0),                       note: 'scored worth a closer look' },
    { key: 'researched', n: (ev.researched ?? 0),                      note: 'investigated, angle found' },
    { key: 'drafted',    n: (ev.drafted ?? 0),                         note: 'message written' },
    { key: 'sent',       n: (stages.sent ?? 0) + (stages.replied ?? 0) + (stages.won ?? 0), note: 'you approved and sent' },
    { key: 'replied',    n: (stages.replied ?? 0) + (stages.won ?? 0), note: 'they wrote back' },
  ];

  return {
    funnel,
    rejected: stages.rejected ?? 0,
    bySource: all('SELECT source, COUNT(*) n FROM leads GROUP BY source ORDER BY n DESC'),
    waiting: all(`SELECT m.id, m.body, m.subject, m.channel, m.status,
                         l.id AS lead_id, l.company, l.contact, l.score, l.angle, l.location, l.offer
                  FROM messages m LEFT JOIN leads l ON l.id = m.lead_id
                  WHERE m.status IN ('draft','pending','approved') ORDER BY m.id`),
    live: all(`SELECT id, company, title, score, status, offer, angle, contact, source
               FROM leads WHERE status IN ('qualified','researched','drafted','sent','replied')
               ORDER BY CASE status WHEN 'replied' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafted' THEN 2
                        WHEN 'researched' THEN 3 ELSE 4 END, score DESC`),
    killed: all(`SELECT company, title, substr(notes,1,160) AS notes FROM leads
                 WHERE status='rejected' AND notes IS NOT NULL ORDER BY id DESC LIMIT 14`),
    events: all("SELECT at, kind, lead_id FROM events WHERE kind NOT LIKE 'hunt%' ORDER BY id DESC LIMIT 18"),
    autopilot: (() => { try { return JSON.parse(readFileSync(join(CONFIG, 'targets.json'), 'utf8')).autopilot ?? { enabled: false }; } catch { return { enabled: false }; } })(),
    paused: one("SELECT value FROM state WHERE key='paused'")?.value === '1',
    inbox: one("SELECT COUNT(*) n FROM messages WHERE direction='in' AND status='received'")?.n ?? 0,
  };
}

function overview(userId = 0) {
  const jobs = {
    total: D.prepare('SELECT COUNT(*) n FROM jobs').get().n,
    byEligibility: (userId && D.prepare('SELECT COUNT(*) n FROM user_jobs WHERE user_id = ?').get(userId).n)
      ? D.prepare('SELECT eligibility, COUNT(*) n FROM user_jobs WHERE user_id = ? GROUP BY eligibility').all(userId)
      : D.prepare('SELECT eligibility, COUNT(*) n FROM jobs GROUP BY eligibility').all(),
    byStatus: D.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all(),
    bySource: D.prepare('SELECT source, COUNT(*) n FROM jobs GROUP BY source ORDER BY n DESC').all(),
  };
  const lastRun = D.prepare("SELECT at, detail FROM events WHERE kind='hunt_run' ORDER BY id DESC LIMIT 1").get();
  const companies = cfg('companies.json').companies.length;
  const cand = cfg('candidate.json');

  const month = new Date().toISOString().slice(0, 7);
  const b = D.prepare('SELECT * FROM budget_months WHERE month = ? AND user_id = ?').get(month, userId);
  const spent = b ? D.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE month=? AND user_id=?').get(month, userId).s : 0;

  return {
    jobs, companies, lastRun: lastRun ? { at: lastRun.at, detail: JSON.parse(lastRun.detail || '{}') } : null,
    mode: cand.eligibility.mode,
    band: { min: cand.compensation.min, max: cand.compensation.max },
    money: b ? { month, allocated: b.allocated, spent, left: b.allocated - spent, currency: b.currency } : { month, allocated: null },
    pendingApproval: D.prepare("SELECT COUNT(*) n FROM applications WHERE status='awaiting_approval' AND user_id = ?").get(userId).n,
    // What happened after you applied. Applying is the middle of the story: 40 sent and 31 refused
    // is the number that says whether the packets are working, and it was nowhere on the page.
    applications: {
      applied: D.prepare('SELECT COUNT(*) n FROM applications WHERE applied_at IS NOT NULL AND user_id = ?').get(userId).n,
      byOutcome: D.prepare(`SELECT outcome, COUNT(*) n FROM applications
        WHERE outcome IS NOT NULL AND user_id = ? GROUP BY outcome`).all(userId),
    },
  };
}

function jobList(q) {
  const where = ['1=1'];
  const args = [];

  if (q.eligibility) { where.push('eligibility = ?'); args.push(q.eligibility); }
  if (q.tier) { where.push(`tier IN (${q.tier.split(',').map(() => '?').join(',')})`); args.push(...q.tier.split(',')); }
  if (q.status) { where.push('status = ?'); args.push(q.status); }
  if (q.company) { where.push('company LIKE ?'); args.push(`%${q.company}%`); }
  if (q.track) { where.push(`track IN (${q.track.split(',').map(() => '?').join(',')})`); args.push(...q.track.split(',')); }

  // Freshness, in hours. A role posted this morning has a handful of applicants; the same role
  // three weeks old has several hundred and probably a shortlist. Filtering here rather than in the
  // browser so it survives paging - filtering after LIMIT would silently drop rows.
  //
  // COALESCE to discovered_at: a posting with no date from the board is not evidence of age, and
  // dropping it would hide jobs for a reason that has nothing to do with them.
  if (q.within && Number(q.within) > 0) {
    where.push(`COALESCE(posted_at, discovered_at) >= ?`);
    args.push(new Date(Date.now() - Number(q.within) * 3600000).toISOString());
  }
  where.push(q.hidden === '1' ? 'hidden = 1' : 'hidden = 0');

  // Salary is compared in USD, so a non-USD posting has to be converted with the same rates the
  // filter uses. Doing it in SQL keeps paging honest - filtering after LIMIT would silently drop rows.
  const fx = JSON.parse(readFileSync(join(CONFIG, 'candidate.json'), 'utf8')).compensation.fxToUSD || {};
  const rateCase = `CASE salary_currency ${Object.entries(fx).filter(([k]) => !k.startsWith('_') && k !== 'asOf')
    .map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(' ')} ELSE 1 END`;
  const perCase = `CASE salary_period WHEN 'hour' THEN 2080 WHEN 'month' THEN 12 ELSE 1 END`;
  const usdMin = `(salary_min * ${rateCase} * ${perCase})`;
  const usdMax = `(COALESCE(salary_max, salary_min) * ${rateCase} * ${perCase})`;

  const hasMin = q.salaryMin && Number(q.salaryMin) > 0;
  const hasMax = q.salaryMax && Number(q.salaryMax) > 0;
  if (hasMin || hasMax) {
    const clauses = [];
    if (hasMin) clauses.push(`${usdMax} >= ?`);
    if (hasMax) clauses.push(`${usdMin} <= ?`);
    const range = `(salary_min IS NOT NULL AND ${clauses.join(' AND ')})`;
    // A posting with no published pay is not the same as one that pays too little, so it gets its
    // own toggle instead of being quietly ranked to the bottom.
    where.push(q.unknownSalary === '0' ? range : `(${range} OR salary_min IS NULL)`);
    if (hasMin) args.push(Number(q.salaryMin));
    if (hasMax) args.push(Number(q.salaryMax));
  } else if (q.unknownSalary === '0') {
    where.push('salary_min IS NOT NULL');
  }

  const order = q.sort === 'pay' ? `${usdMax} DESC NULLS LAST, score DESC`
    : q.sort === 'new' ? 'COALESCE(posted_at, discovered_at) DESC'
    : 'COALESCE(score,-1) DESC, id DESC';

  const limit = Math.min(200, Number(q.limit) || 60);
  const offset = Math.max(0, Number(q.offset) || 0);
  const w = where.join(' AND ');

  const total = D.prepare(`SELECT COUNT(*) n FROM jobs WHERE ${w}`).get(...args).n;
  const rows = D.prepare(`
    SELECT id, company, company_tier, title, url, apply_url, location_raw, salary_min, salary_max,
           salary_currency, salary_period, score, status, eligibility, eligibility_reason,
           posted_at, source, track, tier, ${usdMin} AS usd_min, ${usdMax} AS usd_max,
           LENGTH(COALESCE(content,'')) AS content_len,
           (SELECT a.id FROM applications a WHERE a.job_id = jobs.id ORDER BY a.id DESC LIMIT 1) AS app_id,
           (SELECT a.ats_coverage FROM applications a WHERE a.job_id = jobs.id ORDER BY a.id DESC LIMIT 1) AS ats,
           (SELECT a.approved_at FROM applications a WHERE a.job_id = jobs.id ORDER BY a.id DESC LIMIT 1) AS approved_at
    FROM jobs WHERE ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(...args);

  return { total, offset, limit, rows: rows.map((r) => ({ ...r, payLabel: pay(r) })) };
}

/** How many jobs sit in each tier, so the UI can label the chips honestly. */
function tierSummary(userId = 0) {
  // A user with their own screening sees their own tiers. Until they have run one, they see the
  // shared pool's shape - which is honest, because the pool is the same for everyone and the
  // tiering is the only part that is personal.
  const mine = userId
    ? D.prepare('SELECT COUNT(*) n FROM user_jobs WHERE user_id = ?').get(userId).n : 0;
  const rows = mine
    ? D.prepare('SELECT tier, COUNT(*) n FROM user_jobs WHERE user_id = ? AND hidden = 0 GROUP BY tier').all(userId)
    : D.prepare('SELECT tier, COUNT(*) n FROM jobs WHERE hidden=0 GROUP BY tier').all();
  const n = Object.fromEntries(rows.map((r) => [r.tier, r.n]));
  return [
    { key: 'match', label: 'Apply to these', n: n.match || 0,
      why: 'Work from anywhere, right level, pay in your band.' },
    { key: 'stretch', label: 'Stretch', n: n.stretch || 0,
      why: 'Work from anywhere, but above your level or the pay is unclear. Your call.' },
    { key: 'regional', label: 'Tied to a country', n: n.regional || 0,
      why: 'The right kind of job, but it needs you in a specific place.' },
    { key: 'no', label: 'Not for you', n: n.no || 0,
      why: 'Not full-time, not your field, or a dealbreaker.' },
  ];
}

function trackSummary() {
  const cand = JSON.parse(readFileSync(join(CONFIG, 'candidate.json'), 'utf8'));
  const counts = Object.fromEntries(
    D.prepare("SELECT track, COUNT(*) n FROM jobs WHERE eligibility='yes' AND hidden=0 GROUP BY track").all()
      .map((r) => [r.track, r.n]));
  const all = Object.fromEntries(
    D.prepare('SELECT track, COUNT(*) n FROM jobs WHERE hidden=0 GROUP BY track').all().map((r) => [r.track, r.n]));
  return enabledTracks(cand).map((t) => ({
    key: t.key, label: t.label, salaryMin: t.salaryMin, salaryMax: t.salaryMax,
    eligible: counts[t.key] || 0, total: all[t.key] || 0,
  }));
}

/** One-click searches into the sites that cannot be scraped, pre-filtered to his tracks. */
function deepLinks() {
  const cand = JSON.parse(readFileSync(join(CONFIG, 'candidate.json'), 'utf8'));
  const out = [];
  for (const t of enabledTracks(cand)) {
    const q = encodeURIComponent(t.titles[0]);
    out.push({
      track: t.key, label: t.label,
      links: [
        { site: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${q}&f_WT=2&f_JT=F&sortBy=DD` },
        { site: 'Naukri', url: `https://www.naukri.com/${t.titles[0].replace(/\s+/g, '-')}-jobs?wfhType=0` },
        { site: 'Indeed', url: `https://www.indeed.com/jobs?q=${q}&sc=0kf%3Aattr(DSQF7)%3B&fromage=7` },
        { site: 'Wellfound', url: `https://wellfound.com/role/r/${t.titles[0].replace(/\s+/g, '-')}` },
      ],
    });
  }
  return out;
}

function jobDetail(id) {
  const job = D.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  if (!job) return null;
  const app = D.prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(job.id);
  const dir = join(DATA, 'applications', String(job.id));
  const file = (f) => (existsSync(join(dir, f)) ? f : null);
  // The PDF renders on first request, so "not on disk" is not the same as "not available".
  //
  // This reported null whenever the file was absent, the drawer rendered "not built yet" with no
  // link, and there was no way to trigger the render the server would happily have done. Eleven of
  // seventy-five packets looked like they had no resume at all. They all had one; nobody had asked
  // for it yet.
  const resumeName = app?.resume_path ? app.resume_path.split('/').pop() : null;
  const canRender = resumeName && existsSync(join(dir, 'resume.json'));
  const pdfOnDisk = resumeName && existsSync(join(dir, resumeName));
  const resumePdf = canRender ? resumeName : null;
  return {
    job: { ...job, payLabel: pay(job), content_len: (job.content || '').length },
    application: app || null,
    packet: app ? {
      research: file('research.md'),
      resumePdf,
      // True when it is already rendered; false means the first open spends about 80 seconds in
      // Chrome. The UI says so rather than looking frozen.
      pdfReady: !!pdfOnDisk,
      resumeJson: file('resume.json'),
      loomScript: file('loom/script.md'),
      loomSlides: file('loom/slides.html'),
      loomChecklist: file('loom/checklist.md'),
      jobText: file('job.txt'),
    } : null,
  };
}

/** Same grouping the terminal --near-miss uses, so both views tell the same story. */
function nearMiss() {
  const rows = D.prepare(`SELECT id, company, title, eligibility, eligibility_reason
    FROM jobs WHERE eligibility IN ('no','unclear')`).all()
    .sort((a, b) => String(a.company).localeCompare(String(b.company)) || a.id - b.id);
  const bucket = (reason = '') =>
    /open to India/i.test(reason) ? 'Open to India, not work-from-anywhere'
    : /geographically restricted|restricted to a region/i.test(reason) ? 'Geography'
    : /never states a location/i.test(reason) ? 'Location unstated'
    : /pay .* misses|no salary published/i.test(reason) ? 'Salary band'
    : /too senior|wants \d+\+ years/i.test(reason) ? 'Seniority'
    : /not full-time|contract|part-time|internship|freelance/i.test(reason) ? 'Not full-time'
    : /outside your target roles|not a role you want/i.test(reason) ? 'Role'
    : /dealbreaker/i.test(reason) ? 'Dealbreaker'
    : /not remote/i.test(reason) ? 'Not remote'
    : /no FX rate/i.test(reason) ? 'Currency'
    : 'Other';
  const groups = {};
  for (const r of rows) (groups[bucket(r.eligibility_reason)] ||= []).push(r);
  return Object.entries(groups)
    .map(([name, items]) => ({ name, count: items.length, sample: items.slice(0, 25) }))
    .sort((a, b) => b.count - a.count);
}

function moneyState(month, userId = 0) {
  const c = cfg('money.json');
  const b = D.prepare('SELECT * FROM budget_months WHERE month = ? AND user_id = ?').get(month, userId);
  if (!b) return { month, currency: c.currency, symbol: c.symbol, planned: false, envelopeConfig: c.envelopes };

  const envelopes = D.prepare(`
    SELECT e.name, e.kind, e.planned, COALESCE(SUM(t.amount),0) spent
    FROM envelopes e LEFT JOIN transactions t ON t.month=e.month AND t.envelope=e.name AND t.user_id=e.user_id
    WHERE e.month = ? AND e.user_id = ? GROUP BY e.name, e.kind, e.planned
    ORDER BY CASE e.kind WHEN 'need' THEN 1 WHEN 'want' THEN 2 WHEN 'save' THEN 3 ELSE 4 END, e.name`).all(month, userId);

  const spent = envelopes.reduce((a, e) => a + e.spent, 0);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = new Date();
  const isCurrent = today.toISOString().slice(0, 7) === month;
  const day = isCurrent ? today.getDate() : daysInMonth;
  const daysLeft = Math.max(0, daysInMonth - day);
  const pace = day > 0 ? spent / day : 0;

  return {
    month, planned: true, currency: b.currency, symbol: c.symbol,
    allocated: b.allocated, spent, left: b.allocated - spent,
    closed: !!b.closed_at, daysLeft, daysInMonth,
    perDay: daysLeft > 0 ? (b.allocated - spent) / daysLeft : null,
    projected: pace * daysInMonth,
    envelopes,
    savingsRate: b.allocated
      ? Math.round(envelopes.filter((e) => e.kind === 'save' || e.kind === 'invest')
          .reduce((a, e) => a + e.planned, 0) / b.allocated * 100) : 0,
    recent: D.prepare('SELECT id, at, envelope, amount, note FROM transactions WHERE month=? AND user_id=? ORDER BY id DESC LIMIT 12').all(month, userId),
    goals: D.prepare('SELECT * FROM money_goals WHERE user_id = ? ORDER BY id').all(userId),
    assumedReturn: c.projection.assumedAnnualReturn,
  };
}

// ---------------------------------------------------------------------------
// Running the pipeline. Output streams back as it happens.
// ---------------------------------------------------------------------------

const RUNNABLE = {
  hunt:     ['src/jobs/hunt.mjs'],
  packets:  ['src/jobs/apply.mjs', 'batch', '--tier=all', '--limit=60'],
  score:    ['src/jobs/score.mjs'],
  rescreen: ['src/jobs/hunt.mjs', '--rescreen'],
  verify:   ['src/jobs/hunt.mjs', '--verify-companies'],
  // Client side. `scout` collects leads; it writes nothing outbound and contacts nobody.
  scout:    ['src/scout.mjs'],
};

// Which pipeline run is in flight, if any. Module-level because it guards a machine-wide resource:
// other people's job boards.
let activeRun = null;

function stream(res, args, refuse = null, onExit = null) {
  res.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Refusing still has to answer in the protocol the caller expects, or the page reads an empty
  // body as a run that finished instantly with no output.
  if (refuse) {
    refuse.split('\n').forEach((l) => send('line', l));
    send('done', { code: 1 });
    return res.end();
  }

  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', ...args], { cwd: ROOT });

  let buf = '';
  const pump = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach((l) => send('line', l));
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);
  child.on('close', (code) => { if (buf) send('line', buf); send('done', { code }); res.end(); onExit?.(); });
  child.on('error', (e) => { send('line', `ERROR ${e.message}`); send('done', { code: 1 }); res.end(); onExit?.(); });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const body = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});

function runSync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', ...args], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

// ---------------------------------------------------------------------------

/**
 * Track coverage for an arbitrary fact bank.
 *
 * resume.mjs scoreTracks() reads the owner's master.json from disk, which is correct for the CLI
 * and wrong for a shared server: it answered every user with the owner's resume. This takes the
 * bank as an argument so each account is scored against its own.
 */
function scoreTracksFor(master, candidate) {
  const skills = Object.entries(master?.skills || {})
    .filter(([k, v]) => k !== 'source' && Array.isArray(v)).flatMap(([, v]) => v)
    .map((x) => String(x).toLowerCase());
  const facts = (master?.experience?.length || 0) + (master?.projects?.length || 0);

  return Object.entries(candidate?.tracks || {}).map(([key, t]) => {
    const want = (t.titles || []).map((x) => String(x).toLowerCase());
    const matched = want.filter((w) => skills.some((s) => s.includes(w.split(' ')[0])));
    return {
      track: key,
      label: t.label || key,
      percent: facts ? Math.min(95, Math.round((matched.length / Math.max(want.length, 1)) * 100) + facts * 5) : 0,
      matched: matched.slice(0, 10),
    };
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
);

function setSessionCookie(res, token, expires) {
  // HttpOnly so page scripts cannot read it; SameSite=Lax so another site cannot ride the session.
  // Secure is set only behind a tunnel, because on plain localhost it would stop the cookie working.
  const bits = [`sid=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Expires=${new Date(expires).toUTCString()}`];
  if (SHARE) bits.push('Secure');
  res.setHeader('set-cookie', bits.join('; '));
}

const clearSessionCookie = (res) => res.setHeader('set-cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');

/** Who is asking. In single-user mode that is always the owner, with no login. */
function currentUser(req) {
  if (!SHARE) return { id: 0, email: null, name: 'owner', owner: true };
  const token = parseCookies(req.headers.cookie || '').sid;
  return userForToken(token);
}

// Reachable without being signed in. Everything else is gated.
const PUBLIC_PATHS = new Set(['/', '/index.html', '/api/session', '/api/login', '/api/signup', '/api/logout']);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);

  try {
    const me = currentUser(req);

    // ── auth routes ───────────────────────────────────────────────────────
    if (p === '/api/session') {
      const arms = (profileFor(me && me.owner ? 0 : me?.id || 0).candidate || {}).arms
        || { jobs: true, money: true, clients: false };
      return json(res, me
        ? { signedIn: true, user: { id: me.id, email: me.email, name: me.name }, share: SHARE, arms, readiness: profileReadiness(me.id) }
        : { signedIn: false, share: SHARE, arms });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      // Rate limit per source address, so a shared link cannot be brute forced from one machine.
      const key = `login:${req.socket.remoteAddress}`;
      if (tooManyAttempts(key)) return json(res, { error: 'Too many attempts. Wait fifteen minutes.' }, 429);
      const user = await authenticate(b.email, b.password);
      if (!user) { recordAttempt(key); return json(res, { error: 'Wrong email or password.' }, 401); }
      clearAttempts(key);
      const { token, expires } = startSession(user.id, req.headers['user-agent'] || null);
      setSessionCookie(res, token, expires);
      return json(res, { signedIn: true, user });
    }

    if (p === '/api/signup' && req.method === 'POST') {
      if (!SHARE) return json(res, { error: 'Accounts are only used in shared mode.' }, 400);
      const b = await body(req);
      const key = `signup:${req.socket.remoteAddress}`;
      if (tooManyAttempts(key, { max: 4, windowMs: 60 * 60 * 1000 })) return json(res, { error: 'Too many accounts from here. Try later.' }, 429);
      try {
        const id = await createUser({ email: b.email, password: b.password, name: b.name });
        recordAttempt(key);
        saveProfile(id, profileFor(-1));            // a starter profile, nothing personal in it
        const { token, expires } = startSession(id, req.headers['user-agent'] || null);
        setSessionCookie(res, token, expires);
        return json(res, { signedIn: true, user: { id, email: b.email, name: b.name } });
      } catch (e) {
        return json(res, { error: e.userFacing ? e.message : 'Could not create that account.' }, 400);
      }
    }

    if (p === '/api/logout' && req.method === 'POST') {
      endSession(parseCookies(req.headers.cookie || '').sid);
      clearSessionCookie(res);
      return json(res, { signedIn: false });
    }

    // ── the gate ──────────────────────────────────────────────────────────
    // Everything below this line needs a signed-in user when the port is open. This is a single
    // check rather than a flag on each route, because a route added later would otherwise default
    // to public, and the default has to be closed.
    if (SHARE && !me && !PUBLIC_PATHS.has(p)) {
      return json(res, { error: 'Sign in first.', signedIn: false }, 401);
    }

    if (p === '/' || p === '/index.html') {
      const html = readFileSync(join(ROOT, 'src', 'web', 'app.html'));
      // no-store, because the page is read fresh from disk on every request but the browser was
      // caching it: after any edit the UI silently stayed on the old version until a hard refresh,
      // which reads as "the dashboard is broken" rather than "the dashboard is stale".
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store, must-revalidate' });
      return res.end(html);
    }

    // The client arm is the owner's freelance business, not a shared feature. On a shared
    // instance it does not exist for anyone else rather than returning an empty shell, because an
    // empty shell still tells a visitor it is there.
    if (p === '/api/clients') {
      if (!me.owner) return json(res, { error: 'not found' }, 404);
      const armed = (profileFor(0).candidate || {}).arms?.clients;
      if (armed === false) return json(res, { error: 'not found' }, 404);
      return json(res, clients());
    }
    if (p === '/api/overview') return json(res, overview(me.owner ? 0 : me.id));
    if (p === '/api/jobs') return json(res, jobList(q));
    if (p === '/api/tracks') return json(res, trackSummary());
    if (p === '/api/tiers') return json(res, tierSummary(me.owner ? 0 : me.id));
    // Slide exports are generated on demand rather than on every packet build, because Chrome
    // takes a couple of seconds per deck and most decks are never downloaded.
    if (p.startsWith('/api/slides/')) {
      const [, , , id, format] = p.split('/');
      if (!['pdf', 'pptx'].includes(format)) return json(res, { error: 'pdf or pptx' }, 400);
      if (!me.owner) {
        const owns = D.prepare('SELECT 1 FROM applications WHERE job_id = ? AND user_id = ?').get(Number(id), me.id);
        if (!owns) return json(res, { error: 'not found' }, 404);
      }
      try {
        const { toPdf, toPptx } = await import('../jobs/slides-export.mjs');
        const file = format === 'pptx' ? toPptx(Number(id)) : toPdf(Number(id));
        const buf = readFileSync(file);
        // `attachment` forces a download even when the link opens in a new tab, so there was no
        // way to look at the deck before saving it. ?inline=1 serves the same bytes for viewing.
        // Only meaningful for the PDF; a .pptx has nothing to render it in a browser.
        const inline = q.inline === '1' && format === 'pdf';
        res.writeHead(200, {
          'content-type': format === 'pptx'
            ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'application/pdf',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="slides.${format}"`,
        });
        return res.end(buf);
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    if (p.startsWith('/api/apply/') && p.endsWith('/pack')) {
      const { applyPack } = await import('../jobs/autofill.mjs');
      const pack = applyPack(p.split('/')[3]);
      return pack ? json(res, pack) : json(res, { error: 'not found' }, 404);
    }
    if (p === '/api/deeplinks') return json(res, deepLinks());
    // In shared mode every one of these reads the ASKING user's profile. The gate alone was not
    // enough: it stopped strangers, but a signed-in friend was still served the owner's resume,
    // salary band and work-authorisation status, because the handlers read the files on disk.
    if (p === '/api/config') {
      const mine = profileFor(me.owner ? 0 : me.id);
      return json(res, { candidate: mine.candidate, money: mine.money });
    }

    if (p === '/api/profile') {
      const { scoreTracks, gaps } = await import('../jobs/resume.mjs');
      const mine = profileFor(me.owner ? 0 : me.id);
      const master = mine.master || {};
      // scoreTracks() and gaps() read the owner's file, so they are only meaningful for the owner.
      // A signed-in friend with an empty fact bank gets empty results rather than the owner's.
      const own = !!me.owner;
      return json(res, {
        scores: own ? scoreTracks() : scoreTracksFor(master, mine.candidate),
        gaps: own ? gaps() : [],
        uploads: (master.uploads || []).map((u) => ({ file: u.file, chars: u.chars, addedAt: u.addedAt })),
        answered: (master.ownerStated || []).map((f) => ({ track: f.track, key: f.key, question: f.question, answer: f.answer })),
        identity: master.identity || mine.candidate?.identity || {},
        readiness: profileReadiness(own ? 0 : me.id),
      });
    }
    if (p === '/api/near-miss') return json(res, nearMiss());
    if (p === '/api/money') return json(res, moneyState(q.month || new Date().toISOString().slice(0, 7), me.owner ? 0 : me.id));

    if (p.startsWith('/api/job/')) {
      const d = jobDetail(p.split('/')[3]);
      return d ? json(res, d) : json(res, { error: 'not found' }, 404);
    }

    // Packet files, served read-only and confined to the packet directory.
    if (p.startsWith('/packet/')) {
      const [, , id, ...rest] = p.split('/');
      // A packet holds a real resume with a real phone number on it. Ownership is checked against
      // the applications row, not against whoever happens to be signed in.
      if (!me.owner) {
        const owns = D.prepare('SELECT 1 FROM applications WHERE job_id = ? AND user_id = ?').get(Number(id), me.id);
        if (!owns) return json(res, { error: 'not found' }, 404);
      }
      const rel = normalize(rest.join('/')).replace(/^(\.\.[/\\])+/, '');
      const dir = join(DATA, 'applications', String(Number(id)));
      const file = join(dir, rel);
      if (!file.startsWith(dir)) return json(res, { error: 'not found' }, 404);

      // Render the PDF the first time somebody asks for it.
      //
      // Packets are built without one, because Chrome cold start is 10-270s on this machine and
      // most packets are never opened. The HTML next to it is the artefact; this turns it into a
      // PDF on demand and caches the result.
      if (file.endsWith('.pdf')) {
        const { pdfIsStale, renderOnePage } = await import('../jobs/render.mjs');
        const resumeJson = join(dir, 'resume.json');
        if (existsSync(resumeJson) && pdfIsStale(file)) {
          try { renderOnePage(resumeJson, file); } catch (e) { return json(res, { error: `Could not render: ${e.message}` }, 500); }
        }
      }

      if (!existsSync(file) || !statSync(file).isFile()) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      return res.end(readFileSync(file));
    }

    if (p === '/api/profile/upload' && req.method === 'POST') {
      // Raw body plus ?name=, deliberately: multipart parsing is a lot of surface area for one
      // file upload on a localhost-only server.
      const name = (q.name || 'upload.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (!buf.length) return json(res, { ok: false, error: 'empty file' }, 400);
      const tmp = join(DATA, 'resume', name);
      const { writeFileSync: wf } = await import('node:fs');
      wf(tmp, buf);
      try {
        const { addResume, scoreTracks } = await import('../jobs/resume.mjs');
        const r = addResume(tmp);
        return json(res, { ok: true, file: r.file, chars: r.chars, scores: scoreTracks() });
      } catch (e) { return json(res, { ok: false, error: e.message }, 200); }
    }

    // The owner recording that HE sent a message himself. This is the owner acting, exactly as
    // typing the command would be. It never sends anything: there is no outbound call in this file
    // and there must never be one.
    if (p.startsWith('/api/client/') && p.endsWith('/sent') && req.method === 'POST') {
      if (!me.owner) return json(res, { error: 'not found' }, 404);
      const id = Number(p.split('/')[3]);
      const m = db().prepare('SELECT * FROM messages WHERE id=?').get(id);
      if (!m) return json(res, { error: 'no such message' }, 404);
      db().prepare("UPDATE messages SET status='sent', sent_at=? WHERE id=?").run(now(), id);
      if (m.lead_id) db().prepare("UPDATE leads SET status='sent', updated_at=? WHERE id=?").run(now(), m.lead_id);
      logEvent('sent_by_hand', `msg ${id} marked sent by the owner`, m.lead_id);
      return json(res, { ok: true });
    }

    if (p.startsWith('/api/run/') && req.method === 'POST') {
      const what = p.split('/')[3];
      if (!RUNNABLE[what]) return json(res, { error: 'unknown task' }, 400);

      // One pipeline run at a time, enforced here rather than in the browser.
      //
      // The page had a `running` flag, which stops a second click in the same tab and nothing else:
      // a refresh, a second tab, or a reopened window all start another. Three requests arriving
      // together really did spawn three hunts, and three hunts in twelve minutes is what got the
      // Workable IP banned for a week. A flag in one tab is not a lock.
      if (activeRun) {
        return stream(res, null, `Already running "${activeRun.what}", started ${Math.round((Date.now() - activeRun.at) / 1000)}s ago.\n`
          + 'Only one collection runs at a time, on purpose: several at once is what got this IP\n'
          + 'rate-limited by Workable for a week. Watch the one in progress, or wait for it.');
      }
      activeRun = { what, at: Date.now() };
      return stream(res, RUNNABLE[what], null, () => { activeRun = null; });
    }

    if (req.method === 'POST') {
      const b = await body(req);

      // Money writes go through the ledger CLI, which has no notion of accounts, so the rows it
      // creates are stamped with the caller afterwards. Doing it here keeps one writer of truth.
      const stampMoney = () => { if (!me.owner) {
        for (const t of ['budget_months', 'envelopes', 'transactions', 'money_goals']) {
          D.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = 0`).run(me.id);
        }
      } };

      if (p === '/api/money/plan') {
        const r = await runSync(['src/money/ledger.mjs', 'plan', `--month=${b.month}`, `--amount=${Number(b.amount)}`]);
        stampMoney();
        return json(res, { ok: r.code === 0, out: r.out });
      }
      if (p === '/api/money/spend') {
        const args = ['src/money/ledger.mjs', 'spend', `--envelope=${b.envelope}`, `--amount=${Number(b.amount)}`, `--month=${b.month}`];
        if (b.note) args.push(`--note=${b.note}`);
        const r = await runSync(args);
        stampMoney();
        return json(res, { ok: r.code === 0, out: r.out });
      }
      if (p === '/api/money/goal') {
        const args = b.action === 'fund'
          ? ['src/money/ledger.mjs', 'goal', 'fund', `--name=${b.name}`, `--amount=${Number(b.amount)}`]
          : ['src/money/ledger.mjs', 'goal', 'add', `--name=${b.name}`, `--target=${Number(b.target)}`, ...(b.by ? [`--by=${b.by}`] : [])];
        const r = await runSync(args);
        stampMoney();
        return json(res, { ok: r.code === 0, out: r.out });
      }
      if (p === '/api/money/offer') {
        const args = ['src/money/offer.mjs', `--usd=${Number(b.usd)}`];
        if (b.rate) args.push(`--rate=${Number(b.rate)}`);
        if (b.current) args.push(`--current=${Number(b.current)}`);
        const r = await runSync(args);
        return json(res, { ok: r.code === 0, out: r.out });
      }

      if (p.startsWith('/api/apply/')) {
        const [, , , id, action] = p.split('/');

        // Building everything takes a couple of minutes because Chrome renders two PDFs, so it is
        // streamed rather than awaited. There is still no submit here: `full` runs init, render and
        // the deck exports, and apply.mjs has no send path to reach.
        if (action === 'build') return stream(res, ['src/jobs/apply.mjs', 'full', `--job=${Number(id)}`]);

        // Recording what came back is the owner reporting a fact, not the system deciding one.
        if (action === 'outcome') {
          const { setOutcome } = await import('../db.mjs');
          try {
            const appId = setOutcome(Number(id), { outcome: b.outcome || null, note: b.note || null });
            return json(res, appId ? { ok: true } : { error: 'no application for that job' }, appId ? 200 : 404);
          } catch (e) { return json(res, { error: e.message }, 400); }
        }

        if (!['init', 'render', 'approve', 'applied'].includes(action)) return json(res, { error: 'unknown action' }, 400);

        // The gate. A click here is the owner deciding, exactly as typing the command is - which is
        // why it demands an explicit confirm token rather than firing on a stray request.
        if ((action === 'approve' || action === 'applied') && b.confirm !== 'yes') {
          return json(res, { error: 'confirmation required' }, 400);
        }
        const r = await runSync(['src/jobs/apply.mjs', action, `--job=${Number(id)}`]);
        if (action === 'approve' && r.code === 0) logEvent('approved_via_dashboard', `job ${id}`);
        return json(res, { ok: r.code === 0, out: r.out });
      }

      if (p.startsWith('/api/job/') && p.endsWith('/hide')) {
        const id = Number(p.split('/')[3]);
        setJobHidden(id, b.hidden !== false);
        if (b.company) {
          // "never this employer again" is a suppression, not a per-row flag.
          D.prepare('INSERT OR IGNORE INTO suppression (pattern, reason, added_at) VALUES (?,?,?)')
            .run(b.company, 'hidden from the dashboard', now());
          D.prepare('UPDATE jobs SET hidden=1 WHERE company = ?').run(b.company);
        }
        return json(res, { ok: true });
      }

      if (p === '/api/ingest') {
        const { ingest } = await import('../jobs/ingest.mjs');
        try {
          const r = await ingest({ url: b.url, text: b.text, title: b.title, company: b.company });
          return json(res, { ok: true, ...r });
        } catch (e) { return json(res, { ok: false, error: e.message }, 200); }
      }

      if (p === '/api/profile/answer') {
        const { recordAnswer } = await import('../jobs/resume.mjs');
        recordAnswer(b.track, b.key, b.answer);
        return json(res, { ok: true });
      }

      if (p === '/api/config/mode') {
        // One-line widening of the eligibility filter, from the UI.
        const allowed = ['global-only', 'global-plus-india', 'global-plus-eor'];
        if (!allowed.includes(b.mode)) return json(res, { error: 'bad mode' }, 400);
        const file = join(CONFIG, 'candidate.json');
        const c = JSON.parse(readFileSync(file, 'utf8'));
        c.eligibility.mode = b.mode;
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
        logEvent('eligibility_mode', b.mode);
        return json(res, { ok: true, mode: b.mode, note: 'Re-run the hunt for this to take effect.' });
      }
    }

    json(res, { error: 'not found' }, 404);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

// "Already running" is the most likely reason this fails, and a Node stack trace is a frightening
// way to be told something is fine. Say what happened and what to do about it.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Job Hunter is already running.`);
    console.log(`  Open http://127.0.0.1:${PORT}\n`);
    console.log(`  To restart it instead:  pkill -f src/web/server.mjs && npm run web`);
    console.log(`  To run a second copy:   PORT=4322 npm run web\n`);
    process.exit(0);
  }
  if (err.code === 'EACCES') {
    console.error(`\n  Port ${PORT} needs permission. Try a higher one: PORT=8080 npm run web\n`);
    process.exit(1);
  }
  console.error(`\n  Could not start: ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const pruned = pruneSessions();
  console.log(`\n  Job Hunter`);
  if (SHARE) {
    const n = db().prepare('SELECT COUNT(*) n FROM users').get().n;
    console.log(`  http://${HOST}:${PORT}   SHARED MODE`);
    console.log(`\n  Every route requires a login. ${n} account${n === 1 ? '' : 's'}.`);
    if (!n) console.log(`  No accounts yet: node src/users.mjs create --email=you@example.com`);
    console.log(`  Put this behind a tunnel to share it. Do not open the port directly.`);
  } else {
    console.log(`  http://127.0.0.1:${PORT}\n`);
    console.log(`  Localhost only, no login. Run with SHARE=1 to let other people in.`);
  }
  if (pruned) console.log(`  (${pruned} expired session${pruned === 1 ? '' : 's'} cleared)`);
  console.log(`\n  Nothing here submits an application.\n`);
});
