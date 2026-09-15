#!/usr/bin/env node
// The job pipeline as markdown. This is how /hunt reads state without touching sqlite.
//
//   node src/jobs/report.mjs                 the standing brief
//   node src/jobs/report.mjs --near-miss     what the filter threw away, and why
//   node src/jobs/report.mjs --queue=screened
//   node src/jobs/report.mjs --job=42        everything about one job
import { db } from '../db.mjs';
import { fmt } from './eligibility.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const d = db();

const pay = (r) => r.salary_min
  ? `${fmt(r.salary_min)}–${fmt(r.salary_max)} ${r.salary_currency || ''}/${r.salary_period || 'year'}`.trim()
  : 'not published';

function brief() {
  const total = d.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  if (!total) { console.log('# Job hunt\n\n_No jobs collected yet — run `npm run hunt`._'); return; }

  const byStatus = d.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status ORDER BY n DESC').all();
  const byElig = d.prepare('SELECT eligibility, COUNT(*) n FROM jobs GROUP BY eligibility ORDER BY n DESC').all();
  const bySource = d.prepare('SELECT source, COUNT(*) n FROM jobs GROUP BY source ORDER BY n DESC').all();

  console.log('# Job hunt\n');
  console.log(`${total} role-relevant postings tracked.\n`);

  console.log('## Eligibility');
  byElig.forEach((r) => console.log(`- **${r.eligibility ?? 'unscreened'}**: ${r.n}`));

  console.log('\n## Stage');
  byStatus.forEach((r) => console.log(`- ${r.status}: ${r.n}`));

  console.log('\n## Source');
  bySource.forEach((r) => console.log(`- ${r.source}: ${r.n}`));

  const live = d.prepare(`
    SELECT id, company, company_tier, title, salary_min, salary_max, salary_currency, salary_period,
           score, status, eligibility_reason
    FROM jobs WHERE eligibility='yes' AND status NOT IN ('rejected','closed','applied')
    ORDER BY COALESCE(score,-1) DESC, id DESC LIMIT 20`).all();

  console.log(`\n## Worth your time (${live.length})`);
  if (!live.length) {
    console.log('_Nothing eligible right now._');
    console.log('_This is the strict `global-only` filter doing its job, not a broken scraper._');
    console.log('_Run `--near-miss` to see what it rejected. To widen: set `eligibility.mode` to `global-plus-india` in config/candidate.json._');
  }
  live.forEach((r) => console.log(
    `- [${r.id}] ${r.score ?? '--'} | ${r.company} (${r.company_tier}) | ${r.title}\n    ${pay(r)} · ${r.status} · ${r.eligibility_reason || ''}`
  ));

  const india = d.prepare(`
    SELECT id, company, company_tier, title, salary_min, salary_max, salary_currency, salary_period, score
    FROM jobs WHERE eligibility='unclear' AND eligibility_reason LIKE '%open to India%'
    ORDER BY COALESCE(score,-1) DESC LIMIT 12`).all();
  if (india.length) {
    console.log(`\n## Open to India, but not work-from-anywhere (${india.length})`);
    console.log('_You can take these; they just tie you to the country. Shown because burying them would be dishonest, not because they match what you asked for._');
    india.forEach((r) => console.log(`- [${r.id}] ${r.company} — ${r.title} · ${pay(r)}`));
  }

  const unclear = d.prepare("SELECT COUNT(*) n FROM jobs WHERE eligibility='unclear' AND eligibility_reason NOT LIKE '%open to India%'").get().n;
  if (unclear) console.log(`\n_${unclear} postings never stated a location requirement. Under global-only they are not researched; \`--queue=screened\` lists them._`);
}

/** The honesty check. If these reasons look wrong, the filter is wrong. */
function nearMiss() {
  const rows = d.prepare(`
    SELECT id, company, title, eligibility, eligibility_reason, salary_min, salary_max,
           salary_currency, salary_period
    FROM jobs WHERE eligibility IN ('no','unclear')`).all()
    .sort((a, b) => String(a.company).localeCompare(String(b.company)) || a.id - b.id);

  console.log('# Near misses — what the filter rejected and why\n');
  if (!rows.length) { console.log('_Nothing rejected yet._'); return; }

  // Grouped by the shape of the reason, so a systematically wrong rule is obvious at a glance
  // rather than hidden across three hundred individual lines.
  const bucket = (reason = '') =>
    /geographically restricted|restricted to a region/i.test(reason) ? 'Geography'
    : /never states a location/i.test(reason) ? 'Location unstated (unclear)'
    : /pay .* misses|no salary published/i.test(reason) ? 'Salary band'
    : /too senior|wants \d+\+ years/i.test(reason) ? 'Seniority'
    : /not full-time|contract|part-time|internship|freelance/i.test(reason) ? 'Not full-time'
    : /outside your target roles|not a role you want/i.test(reason) ? 'Role'
    : /dealbreaker/i.test(reason) ? 'Dealbreaker'
    : /not remote/i.test(reason) ? 'Not remote'
    : /needs a manual look/i.test(reason) ? 'Currency'
    : 'Other';

  const groups = {};
  for (const r of rows) (groups[bucket(r.eligibility_reason)] ||= []).push(r);

  for (const [name, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`## ${name} — ${list.length}\n`);
    for (const r of list.slice(0, 12)) {
      console.log(`- **${r.company}** — ${r.title}  \n  ${r.eligibility_reason}`);
    }
    if (list.length > 12) console.log(`- _…and ${list.length - 12} more_`);
    console.log('');
  }
  console.log('---');
  console.log('If a reason here looks wrong, the rule that produced it is wrong — fix `src/jobs/eligibility.mjs` before anything gets tailored.');
}

function queue(status) {
  const rows = d.prepare(`
    SELECT id, source, company, company_tier, title, url, location_raw, employment_type,
           salary_min, salary_max, salary_currency, salary_period, score, eligibility,
           eligibility_reason FROM jobs WHERE status = ? ORDER BY COALESCE(score,-1) DESC, id DESC LIMIT 40`).all(status);
  console.log(`# Jobs at "${status}" (${rows.length})\n`);
  rows.forEach((r) => {
    console.log(`## [${r.id}] ${r.company} — ${r.title}`);
    console.log(`- ${r.url}`);
    console.log(`- ${r.location_raw || 'location not stated'} · ${r.employment_type} · ${pay(r)}`);
    console.log(`- eligibility: **${r.eligibility}** — ${r.eligibility_reason}`);
    console.log(`- tier: ${r.company_tier} · score: ${r.score ?? '--'}\n`);
  });
}

function one(id) {
  const r = d.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  if (!r) { console.log(`No job ${id}.`); return; }
  console.log(`# [${r.id}] ${r.company} — ${r.title}\n`);
  console.log(`- **url**: ${r.url}`);
  console.log(`- **apply**: ${r.apply_url}`);
  console.log(`- **location**: ${r.location_raw || '—'}  (scope: ${r.remote_scope}, detail: ${r.remote_detail || '—'})`);
  console.log(`- **type**: ${r.employment_type} · **pay**: ${pay(r)} (${r.salary_source})`);
  console.log(`- **status**: ${r.status} · **score**: ${r.score ?? '--'}`);
  console.log(`- **eligibility**: ${r.eligibility} (${r.eligibility_layer}) — ${r.eligibility_reason}`);
  console.log(`- **posted**: ${r.posted_at || '—'}`);
  const app = d.prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(r.id);
  if (app) {
    console.log(`\n## Application\n- status: ${app.status} · packet: ${app.packet_dir || '—'}`);
    console.log(`- ATS coverage: ${app.ats_coverage ?? '--'}%  · approved: ${app.approved_at || 'NOT APPROVED'}`);
  }
  console.log(`\n## Job description\n\n${r.content || '_none captured_'}`);
}

const job = arg('job'); const q = arg('queue');
if (flag('near-miss')) nearMiss();
else if (job) one(job);
else if (q) queue(q);
else brief();
