#!/usr/bin/env node
// Assembles an application packet and holds it at the gate.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: nothing is ever submitted from here. `approve` records the
// owner's decision and nothing else; there is no send, no form post, no upload. Applying is a
// deliberate act the owner performs, one job at a time, after reading what was written in their name.
//
//   node src/jobs/apply.mjs init    --job=42     create the packet folder and seed the resume
//   node src/jobs/apply.mjs render  --job=42     resume.json -> PDF, and score ATS coverage
//   node src/jobs/apply.mjs review  --job=42     the one-screen read before you decide
//   node src/jobs/apply.mjs approve --job=42     you, saying yes. Only you run this.
//   node src/jobs/apply.mjs applied --job=42     record that you actually sent it
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, db, now, logEvent } from '../db.mjs';
import { renderOnePage, writeHtmlOnly } from './render.mjs';
import { coverage, resumeText } from './ats.mjs';
import { researchJob } from './research.mjs';
import { loomJob } from './loom.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const cmd = process.argv[2];
const D = db();

const getJob = (id) => {
  const j = D.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  if (!j) { console.error(`No job ${id}.`); process.exit(1); }
  return j;
};
const packetDir = (id) => join(DATA, 'applications', String(id));
const getApp = (jobId) => D.prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(Number(jobId));

function init(id, { quiet = false } = {}) {
  const job = getJob(id);
  const dir = packetDir(id);
  mkdirSync(join(dir, 'loom'), { recursive: true });

  // The full job description on disk, so the researcher and tailorer read the same text the
  // owner will be interviewed against.
  writeFileSync(join(dir, 'job.txt'), `${job.company} — ${job.title}\n${job.url}\n${job.location_raw || ''}\n\n${job.content || ''}`);

  // Research first. The dossier is what the packet is built on, not an afterthought bolted to it,
  // and it is what tells the owner which of the posting's demands he can actually evidence.
  const dossier = researchJob(job.id, { quiet: true });

  const master = JSON.parse(readFileSync(join(DATA, 'resume', 'master.json'), 'utf8'));
  const seed = join(dir, 'resume.json');

  // A deterministic first pass, so every packet starts relevant instead of identical.
  // The agent still does the real tailoring; this just means a media-buying packet does not open
  // with Kubernetes, and the skills the posting actually names are already at the front.
  const jdWords = new Set((job.content || '').toLowerCase().match(/[a-z][a-z0-9+.#-]{2,}/g) || []);
  // Skills come from the fact bank, never from a list in this file.
  //
  // A hardcoded per-track list was putting "Python" and "SQL / MySQL" on every dev packet because
  // the list said so, not because any resume did. That is the invention rule being broken by the
  // seeding code itself, which is worse than an agent doing it: it is silent and it is everywhere.
  const bankSkills = Object.entries(master.skills || {})
    .filter(([k, v]) => k !== 'source' && Array.isArray(v))
    .flatMap(([, v]) => v)
    .filter((x, i, a) => a.indexOf(x) === i);

  // The posting decides the ORDER, the fact bank decides the CONTENT. Same theme every time; what
  // leads changes with the job.
  const relevance = (skill) => {
    const words = String(skill).toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1);
    return words.some((w) => jdWords.has(w)) ? 0 : 1;
  };
  const skills = [...bankSkills].sort((a, b) => relevance(a) - relevance(b)).slice(0, 12);

  // Refresh the seed when the fact bank is newer than it, or when asked.
  //
  // This used to be "write only if missing", which meant uploading a new resume changed nothing for
  // the packets already on disk: they kept quoting a profile line and a skill list the owner had
  // replaced. A packet is a view of the fact bank, so a newer bank wins.
  const bankNewer = existsSync(seed)
    && statSync(join(DATA, 'resume', 'master.json')).mtimeMs > statSync(seed).mtimeMs;

  if (!existsSync(seed) || bankNewer || flag('force')) {
    // Seeded straight from the fact bank. The tailorer edits this down; it never adds to it.
    writeFileSync(seed, JSON.stringify({
      _instructions: 'Select and rephrase from data/resume/master.json ONLY. Every bullet must trace to a fact there. Do not invent employers, dates, metrics or skills.',
      _track: job.track,
      identity: master.identity,
      summary: master.profile.current,
      skills,
      // One page is the brief, so the seed already has the shape: three bullets a role, two projects.
      experience: master.experience.map((e) => ({
        title: e.title, company: e.company, dates: `${e.start} – ${e.end}`, bullets: e.bullets.slice(0, 3),
      })),
      projects: master.projects
        .filter((p) => job.track !== 'marketing' || /agent|system|data/i.test(p.name))
        .slice(0, 2)
        .map((p) => ({ title: p.name, sub: p.context, bullets: p.bullets.slice(0, 3) })),
      education: master.education.slice(0, 1).map((e) => ({ credential: e.credential, institution: e.institution, dates: `${e.start} – ${e.end}`, sub: e.grade })),
    }, null, 2));
  }

  // The Loom package, from the same dossier.
  const loom = loomJob(job.id, { quiet: true });

  const existing = getApp(id);
  if (!existing) {
    D.prepare(`INSERT INTO applications (job_id, packet_dir, status, created_at) VALUES (?,?,'building',?)`).run(job.id, dir, now());
  }
  D.prepare(`UPDATE applications SET research_path=?, loom_script_path=?, loom_slides_path=? WHERE job_id=?`)
    .run(dossier.path, join(loom.dir, 'script.md'), join(loom.dir, 'slides.html'), job.id);
  D.prepare("UPDATE jobs SET status='researched', updated_at=? WHERE id=?").run(now(), job.id);
  if (quiet) return;
  console.log(`Packet ready: ${dir}`);
  console.log(`  job.txt      the posting, verbatim`);
  console.log(`  research.md  what they want, what you can evidence, what you cannot`);
  console.log(`  resume.json  seeded from the fact bank — resume-tailor edits this down`);
  console.log(`  loom/        script.md (${loom.words} words), slides.html (${loom.slides} slides), checklist.md`);
}

/**
 * Write the packet's resume and score it.
 *
 * The PDF is NOT rendered here by default, and that is the point. Chrome cold start on this machine
 * measured between 10 and 270 seconds depending on what else it was doing, so rendering a PDF for
 * all 57 packets cost hours and produced 57 files, most of which are never opened. The HTML is the
 * artefact; the PDF is a rendering of it, made on demand when someone actually asks for it and
 * cached from then on.
 *
 * Pass { pdf: true } (or --pdf) to force it, which is what a single-packet render does.
 */
function render(id, { quiet = false, pdf: wantPdf = flag('pdf') } = {}) {
  const job = getJob(id);
  const dir = packetDir(id);
  const resumeJson = join(dir, 'resume.json');
  if (!existsSync(resumeJson)) { console.error(`No resume.json yet. Run: node src/jobs/apply.mjs init --job=${id}`); process.exit(1); }

  // The candidate's name comes from the fact bank, not from this file. It was hardcoded, which
  // meant every resume this repo rendered - including one rendered by someone who cloned it - was
  // filed under the original owner's name.
  const who = (JSON.parse(readFileSync(join(DATA, 'resume', 'master.json'), 'utf8')).identity?.name || 'resume')
    .replace(/[^a-z0-9]+/gi, '_');
  const pdf = join(dir, `${(job.company || 'company').replace(/[^a-z0-9]+/gi, '_')}_${who}.pdf`);
  const out = wantPdf
    ? renderOnePage(resumeJson, pdf)
    : writeHtmlOnly(resumeJson, pdf);

  const resume = JSON.parse(readFileSync(resumeJson, 'utf8'));
  const cov = coverage(job.content || '', resumeText(resume));

  // Rendered means the packet is complete and the only thing left is the owner's decision.
  // Leaving it at 'building' meant the dashboard reported 0 waiting while 57 sat finished.
  const already = getApp(job.id);
  D.prepare('UPDATE applications SET resume_path=?, ats_coverage=?, status=? WHERE job_id=?')
    .run(out.pdf, cov.percent, already?.approved_at ? already.status : 'awaiting_approval', job.id);
  D.prepare("UPDATE jobs SET status='tailored', updated_at=? WHERE id=?").run(now(), job.id);

  if (quiet) return;
  console.log(out.pages
    ? `PDF   ${out.pdf}  (${out.pages} page${out.pages === 1 ? '' : 's'})`
    : `HTML  ${out.html}\n      PDF renders when you open it — add --pdf to force it now`);
  if (out.trims?.length) {
    console.log(`      trimmed to fit one page: ${out.trims.join('; ')}`);
  }
  if (out.overflow) console.log(`      STILL OVER ONE PAGE — cut something by hand.`);
  console.log(`ATS   ${cov.percent}% of the posting's top terms appear in the resume`);
  if (cov.missing.length) {
    console.log(`\nTerms the posting leans on that your resume never says:`);
    console.log(`  ${cov.missing.slice(0, 18).join(', ')}`);
    console.log(`\nOnly close the gaps that are genuinely true of you. A keyword you cannot defend in an`);
    console.log(`interview costs more than the one you left out.`);
  }
}

function review(id) {
  const job = getJob(id);
  const app = getApp(id);
  const dir = packetDir(id);
  const has = (f) => (existsSync(join(dir, f)) ? 'yes' : 'MISSING');

  console.log(`# ${job.company} — ${job.title}\n`);
  console.log(`  url        ${job.url}`);
  console.log(`  apply at   ${job.apply_url}`);
  console.log(`  location   ${job.location_raw || '—'}`);
  console.log(`  pay        ${job.salary_min ? `${job.salary_min}–${job.salary_max} ${job.salary_currency}/${job.salary_period}` : 'not published'}`);
  console.log(`  score      ${job.score ?? '--'}`);
  console.log(`  why open   ${job.eligibility_reason}\n`);
  console.log(`  research   ${has('research.md')}`);
  console.log(`  resume     ${app?.resume_path ? 'rendered' : 'MISSING'}   ATS coverage ${app?.ats_coverage ?? '--'}%`);
  console.log(`  loom script ${has('loom/script.md')}`);
  console.log(`  loom slides ${has('loom/slides.html')}\n`);

  if (app?.approved_at) {
    console.log(`  APPROVED ${app.approved_at}`);
    console.log(`\n  Apply here yourself: ${job.apply_url}`);
  } else {
    console.log(`  NOT APPROVED. Nothing has been sent and nothing will be.`);
    console.log(`  Read the packet in ${dir}, then: node src/jobs/apply.mjs approve --job=${id}`);
  }
}

function approve(id) {
  const app = getApp(id);
  if (!app) { console.error(`No packet for job ${id}. Run init first.`); process.exit(1); }
  D.prepare("UPDATE applications SET status='ready', approved_at=? WHERE id=?").run(now(), app.id);
  D.prepare("UPDATE jobs SET status='ready', updated_at=? WHERE id=?").run(now(), Number(id));
  logEvent('application_approved', `job ${id}`, null);
  const job = getJob(id);
  console.log(`Approved. Nothing has been submitted — that part is yours:\n\n  ${job.apply_url}\n`);
  console.log(`Record it once you have: node src/jobs/apply.mjs applied --job=${id}`);
}

function applied(id) {
  const app = getApp(id);
  if (!app?.approved_at) { console.error(`Job ${id} was never approved. Approve it first.`); process.exit(1); }
  D.prepare("UPDATE applications SET status='applied', applied_at=? WHERE id=?").run(now(), app.id);
  D.prepare("UPDATE jobs SET status='applied', updated_at=? WHERE id=?").run(now(), Number(id));
  logEvent('application_sent', `job ${id}`, null);
  console.log(`Recorded as applied.`);
}

/**
 * Build a packet for every job worth one, in one go.
 *
 * Doing this per job by hand meant exactly one of 4,582 collected jobs ever got a packet. The
 * expensive parts — research, the Loom script — still need an agent per job, but the packet folder,
 * the job text, the seeded resume and a rendered one-page PDF are all mechanical, and there is no
 * reason for the owner to click twice for each of them.
 *
 *   node src/jobs/apply.mjs batch                 every 'match'
 *   node src/jobs/apply.mjs batch --tier=stretch
 *   node src/jobs/apply.mjs batch --limit=20
 */
async function batch() {
  const tier = arg('tier', 'match');
  const limit = Number(arg('limit')) || 50;
  const tiers = tier === 'all' ? ['match', 'stretch'] : tier.split(',');

  const jobs = D.prepare(`
    SELECT id, company, title FROM jobs
    WHERE tier IN (${tiers.map(() => '?').join(',')}) AND hidden = 0
    ORDER BY COALESCE(score,-1) DESC LIMIT ?`).all(...tiers, limit);

  if (!jobs.length) { console.log(`No jobs at tier ${tiers.join('/')}.`); return; }
  console.log(`Building ${jobs.length} packet${jobs.length === 1 ? '' : 's'} (${tiers.join(', ')})\n`);

  // Sequential, deliberately.
  //
  // An earlier version ran four "lanes" over this list. It did nothing: init and render are
  // synchronous and execFileSync blocks the whole thread, so the lanes took turns anyway while
  // making failures much harder to read. Chrome cold start is the real cost (~20s a packet on this
  // machine) and the fix for that is rendering fewer times, not pretending to render concurrently.
  let built = 0, failed = 0;
  for (const j of jobs) {
    try {
      init(j.id, { quiet: true });
      render(j.id, { quiet: true });
      built++;
      const app = getApp(j.id);
      console.log(`  ok   [${String(j.id).padStart(5)}] ${(j.company || '?').slice(0, 20).padEnd(22)} ${j.title.slice(0, 40).padEnd(42)} ATS ${String(app?.ats_coverage ?? '--').padStart(3)}%`);
    } catch (e) {
      failed++;
      console.log(`  FAIL [${String(j.id).padStart(5)}] ${(j.company || '?').slice(0, 20).padEnd(22)} ${e.message.slice(0, 60)}`);
    }
  }

  console.log(`\n${built} packet${built === 1 ? '' : 's'} built${failed ? `, ${failed} failed` : ''}.`);
  console.log(`Each one has: the posting, a research dossier, a one-page tailored resume,`);
  console.log(`a 90-second Loom script, a slide deck and a recording checklist.`);
  console.log(`\nThe dossiers are a mechanical pass over the posting. For a job you decide to pursue,`);
  console.log(`run job-researcher on it to add funding, news and a confirmed remote policy.`);
  console.log(`\nNothing has been submitted. Approve individually when you have read one.`);
}

/**
 * Everything, in one go, with the PDFs.
 *
 * `init` then `render` leaves the resume as HTML and defers the PDF until someone opens it, which
 * is the right default for building 60 packets at once - Chrome takes over a minute each. It is the
 * wrong default for one job the owner has just decided they care about: they press a button and
 * want the finished thing, not a promise of one.
 *
 * Runs as a single process so the dashboard can stream it, and prints each step as it starts so a
 * two-minute wait looks like progress rather than a hang.
 */
async function full(jobId) {
  const job = getJob(jobId);
  const started = Date.now();
  console.log(`Building the full packet for ${job.company || '?'} — ${job.title}`);
  console.log(`Chrome renders the PDFs, which is the slow part. Expect a couple of minutes.\n`);

  console.log('[1/4] posting, research dossier, tailored resume, Loom script and deck');
  init(jobId, { quiet: true });

  console.log('[2/4] resume to PDF, and the one-page check');
  render(jobId, { quiet: false, pdf: true });

  console.log('\n[3/4] deck to PDF');
  const { toPdf, toPptx } = await import('./slides-export.mjs');
  try { toPdf(Number(jobId)); console.log('      loom/slides.pdf'); }
  catch (e) { console.log(`      skipped: ${e.message}`); }

  console.log('[4/4] deck to PowerPoint');
  try { toPptx(Number(jobId)); console.log('      loom/slides.pptx'); }
  catch (e) { console.log(`      skipped: ${e.message}`); }

  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s. Nothing has been submitted.`);
  console.log('Read it, then approve it yourself if you want to apply.');
}

const id = arg('job');
if (cmd === 'batch') { await batch(); }
else if (!cmd || !id) {
  console.error('usage: node src/jobs/apply.mjs <init|render|full|review|approve|applied> --job=<id>');
  console.error('       node src/jobs/apply.mjs outcome --job=<id> --result=rejected|interview|offer|ghosted|clear [--note="..."]');
  console.error('       node src/jobs/apply.mjs batch [--tier=match|stretch|all] [--limit=N]');
  process.exit(1);
} else if (cmd === 'full') {
  await full(id);
} else if (cmd === 'outcome') {
  const result = arg('result');
  const note = arg('note', null);
  const { setOutcome } = await import('../db.mjs');
  try {
    const appId = setOutcome(id, { outcome: result === 'clear' ? null : result, note });
    if (!appId) { console.error(`No application for job ${id}. Build a packet first.`); process.exit(1); }
    console.log(result === 'clear' ? `Cleared the outcome on job ${id}.` : `Job ${id}: ${result}${note ? ` — ${note}` : ''}`);
    logEvent('outcome', { job: Number(id), result, note });
  } catch (e) { console.error(e.message); process.exit(1); }
} else {
  ({ init, render, review, approve, applied }[cmd] || (() => { console.error(`Unknown command "${cmd}".`); process.exit(1); }))(id);
}
