#!/usr/bin/env node
// The job hunt. Two kinds of source, deliberately:
//
//   GLOBAL   one feed or one set of searches, run once. Workable searches for the owner's actual
//            track titles, so coverage follows what he does rather than which employers I happened
//            to list. This is what makes marketing roles appear at all.
//   COMPANY  polls one board per company in config/companies.json. Good for brands, useless for
//            finding a job at a company nobody thought to add.
//
//   node src/jobs/hunt.mjs                          everything
//   node src/jobs/hunt.mjs --source=workable        one source
//   node src/jobs/hunt.mjs --track=marketing        one track only
//   node src/jobs/hunt.mjs --company=gitlab
//   node src/jobs/hunt.mjs --dry-run                print, write nothing
//   node src/jobs/hunt.mjs --verify-companies
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, ROOT, upsertJob, setJobVerdict, logEvent, isSuppressed, db } from '../db.mjs';
import { screen, roleRelevant, tierOf, fmt } from './eligibility.mjs';
import { enabledTracks } from './tracks.mjs';

// SmartRecruiters is deliberately absent: the API works, but every company slug tried returned zero
// postings, and an adapter that can never return a row is worse than no adapter.
const GLOBAL = {
  workable: './boards/workable.mjs',
  himalayas: './boards/himalayas.mjs',
  remoteok: './boards/remoteok.mjs',
  workingnomads: './boards/workingnomads.mjs',
  jobicy: './boards/jobicy.mjs',
  arbeitnow: './boards/arbeitnow.mjs',
  remotive: './boards/remotive.mjs',
};
const COMPANY = {
  ashby: './boards/ashby.mjs',
  greenhouse: './boards/greenhouse.mjs',
  lever: './boards/lever.mjs',
};

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);

function loadConfig(onlyTrack) {
  const companies = JSON.parse(readFileSync(join(CONFIG, 'companies.json'), 'utf8'));
  const candidate = JSON.parse(readFileSync(join(CONFIG, 'candidate.json'), 'utf8'));
  if (onlyTrack) {
    if (!candidate.tracks[onlyTrack]) {
      console.error(`Unknown track "${onlyTrack}". Known: ${Object.keys(candidate.tracks).join(', ')}`);
      process.exit(1);
    }
    candidate.tracks = { [onlyTrack]: candidate.tracks[onlyTrack] };
  }
  return { companies, candidate };
}

/** Run `worker` over `items` with a small fixed concurrency. Polite to the boards, still fast. */
async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await worker(items[n], n); }
  }));
  return out;
}

async function verifyCompanies() {
  const { companies } = loadConfig();
  console.log(`Verifying ${companies.companies.length} boards…\n`);
  const results = await pool(companies.companies, 6, async (c) => {
    try {
      const mod = await import(COMPANY[c.ats]);
      const jobs = await mod.collect(null, { slug: c.slug, company: c });
      return { ...c, live: jobs.length > 0, n: jobs.length };
    } catch (e) { return { ...c, live: false, n: 0, err: e.message }; }
  });
  const dead = results.filter((r) => !r.live);
  results.filter((r) => r.live).forEach((r) => console.log(`  ok    ${r.ats.padEnd(11)} ${r.slug.padEnd(16)} ${r.n} jobs`));
  dead.forEach((r) => console.log(`  DEAD  ${r.ats.padEnd(11)} ${r.slug.padEnd(16)} ${r.err || 'no jobs returned'}`));
  console.log(`\n${results.length - dead.length} live, ${dead.length} dead.`);
}

/**
 * Re-run the rules over jobs already stored, without touching the network.
 * Changing an exclusion or a salary floor should not cost a full hunt, and re-fetching thousands of
 * postings to answer "what would this setting have done" is how you end up not checking.
 */
function rescreen() {
  const { candidate } = loadConfig(arg('track'));
  const d = db();
  const rows = d.prepare('SELECT * FROM jobs').all();
  const tally = { yes: 0, unclear: 0, no: 0, dropped: 0 };
  const byTrack = {};

  for (const job of rows) {
    const track = roleRelevant(job, candidate);
    if (!track) {
      // No longer one of his roles - an exclusion now covers it. Drop it unless a packet exists.
      const hasPacket = d.prepare('SELECT 1 FROM applications WHERE job_id = ?').get(job.id);
      if (!hasPacket) { d.prepare('DELETE FROM jobs WHERE id = ?').run(job.id); tally.dropped++; }
      continue;
    }
    const v = screen(job, candidate, track);
    const key = v.track || 'unknown';
    byTrack[key] ||= { yes: 0, unclear: 0, no: 0 };
    const bucket = v.eligibility === 'yes' ? 'yes' : v.eligibility === 'unclear' ? 'unclear' : 'no';
    byTrack[key][bucket]++; tally[bucket]++;
    setJobVerdict(job.id, {
      eligibility: v.eligibility, reason: v.reason, layer: v.layer,
      status: v.eligibility === 'no' ? 'rejected' : (job.status === 'new' ? 'screened' : job.status),
      track: v.track, tier: tierOf(v),
    });
  }

  console.log(`Re-screened ${rows.length} stored jobs under mode "${candidate.eligibility.mode}".\n`);
  console.log(`  eligible ${tally.yes}   unclear ${tally.unclear}   rejected ${tally.no}   dropped ${tally.dropped}\n`);
  for (const [k, v] of Object.entries(byTrack).sort((a, b) => b[1].yes - a[1].yes)) {
    console.log(`    ${k.padEnd(11)} eligible ${String(v.yes).padStart(4)}   unclear ${String(v.unclear).padStart(4)}   rejected ${String(v.no).padStart(5)}`);
  }
  logEvent('rescreen', tally);
}

async function main() {
  if (flag('verify-companies')) return verifyCompanies();
  if (flag('rescreen')) return rescreen();

  const onlyTrack = arg('track');
  const cfg = loadConfig(onlyTrack);
  const { companies, candidate } = cfg;
  const dryRun = flag('dry-run');
  const onlySource = arg('source');
  const onlyCompany = arg('company');

  const globalNames = Object.keys(GLOBAL).filter((n) => (!onlySource || onlySource === n) && !onlyCompany);
  let targets = companies.companies;
  if (onlySource && !GLOBAL[onlySource]) targets = targets.filter((c) => c.ats === onlySource);
  else if (onlySource) targets = [];
  if (onlyCompany) targets = companies.companies.filter((c) => c.slug === onlyCompany);

  const tracks = enabledTracks(candidate);
  console.log(`Hunt${dryRun ? ' (dry run, nothing will be written)' : ''}`);
  console.log(`Tracks: ${tracks.map((t) => `${t.key} ($${t.salaryMin / 1000}k+)`).join(', ')}`);
  console.log(`Sources: ${globalNames.join(', ')}${targets.length ? ` + ${targets.length} company boards` : ''}\n`);

  const tally = { seen: 0, offRole: 0, stored: 0, dup: 0, yes: 0, unclear: 0, no: 0, errors: 0 };
  const byTrack = {};
  const matches = [];

  const handle = (jobs, sourceLabel) => {
    for (const job of jobs) {
      tally.seen++;
      const track = roleRelevant(job, candidate);
      if (!track) { tally.offRole++; continue; }
      if (isSuppressed(job.company, job.url)) continue;

      const verdict = screen(job, candidate, track);
      const key = verdict.track || 'unknown';
      byTrack[key] ||= { yes: 0, unclear: 0, no: 0 };
      byTrack[key][verdict.eligibility === 'yes' ? 'yes' : verdict.eligibility === 'unclear' ? 'unclear' : 'no']++;
      tally[verdict.eligibility === 'yes' ? 'yes' : verdict.eligibility === 'unclear' ? 'unclear' : 'no']++;
      if (verdict.eligibility === 'yes') matches.push({ job, verdict });

      if (dryRun) { tally.stored++; continue; }

      const sal = verdict.salary;
      const { result, id } = upsertJob({
        ...job,
        track: verdict.track,
        salary_min: job.salary_min ?? sal?.min ?? null,
        salary_max: job.salary_max ?? sal?.max ?? null,
        salary_currency: job.salary_currency ?? sal?.currency ?? null,
        salary_period: job.salary_period ?? sal?.period ?? null,
        salary_source: job.salary_source === 'structured' ? 'structured' : (sal?.source ?? 'unknown'),
      });
      if (result === 'duplicate') { tally.dup++; continue; }
      tally.stored++;
      setJobVerdict(id, {
        eligibility: verdict.eligibility,
        reason: verdict.reason,
        layer: verdict.layer,
        status: verdict.eligibility === 'no' ? 'rejected' : 'screened',
        track: verdict.track,
        tier: tierOf(verdict),
      });
    }
    if (sourceLabel) console.log(`  ${sourceLabel.padEnd(12)} ${String(jobs.length).padStart(5)} returned`);
  };

  for (const name of globalNames) {
    try {
      const mod = await import(GLOBAL[name]);
      handle(await mod.collect(cfg, {}), name);
    } catch (e) {
      tally.errors++;
      console.log(`  ${name.padEnd(12)} ERROR ${e.message}`);
      logEvent('hunt_error', `${name} ${e.message}`);
    }
  }

  if (targets.length) {
    const collected = [];
    await pool(targets, 6, async (c) => {
      try {
        const mod = await import(COMPANY[c.ats]);
        collected.push(...await mod.collect(cfg, { slug: c.slug, company: c }));
      } catch (e) { tally.errors++; logEvent('hunt_error', `${c.ats}:${c.slug} ${e.message}`); }
    });
    handle(collected, 'company boards');
  }

  console.log('');
  console.log(`  postings seen         ${tally.seen}`);
  console.log(`  not one of your roles ${tally.offRole}  (not stored)`);
  console.log(`  yours                 ${tally.seen - tally.offRole}`);
  console.log(`    eligible            ${tally.yes}`);
  console.log(`    unclear             ${tally.unclear}`);
  console.log(`    rejected            ${tally.no}`);
  console.log(`  new rows              ${tally.stored}   duplicates ${tally.dup}   errors ${tally.errors}`);

  console.log(`\n  by track:`);
  for (const [k, v] of Object.entries(byTrack).sort((a, b) => b[1].yes - a[1].yes)) {
    console.log(`    ${k.padEnd(11)} eligible ${String(v.yes).padStart(4)}   unclear ${String(v.unclear).padStart(4)}   rejected ${String(v.no).padStart(5)}`);
  }

  if (matches.length) {
    console.log(`\n  Eligible right now:`);
    for (const { job, verdict } of matches.slice(0, 20)) {
      const p = job.salary_min ? `${fmt(job.salary_min)}–${fmt(job.salary_max)}` : verdict.salary ? `${fmt(verdict.salary.min)}–${fmt(verdict.salary.max)}` : 'pay not published';
      console.log(`  · [${(verdict.track || '?').padEnd(9)}] ${(job.company || '?').slice(0, 18).padEnd(20)} ${job.title.slice(0, 44).padEnd(46)} ${p}`);
    }
  }

  if (!dryRun) {
    logEvent('hunt_run', { ...tally, byTrack });
    console.log(`\nNext: node src/jobs/report.mjs           what is worth your time`);
    console.log(`      node src/jobs/report.mjs --near-miss  what the filter threw away, and why`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
