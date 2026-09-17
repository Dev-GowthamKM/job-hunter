#!/usr/bin/env node
// Ranks jobs that already PASSED the eligibility gate. Eligibility is a gate, not a weight: no
// amount of company prestige can score a US-only role into contention, so nothing here can
// resurrect something the gate rejected.
//
//   node src/jobs/score.mjs              score everything at 'screened'
//   node src/jobs/score.mjs --all        re-score, including already-scored jobs
//   node src/jobs/score.mjs --job=42
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, ROOT, db, now, logEvent } from '../db.mjs';
import { bandFor, resolveTrack } from './tracks.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const TIER_POINTS = { brand: 1.0, 'funded-startup': 0.85, watch: 0.45, unknown: 0.4 };

/** How much of the job's own language the owner can actually claim. */
function roleFit(job, cand) {
  const text = `${job.title} ${job.content || ''}`.toLowerCase();
  const title = (job.title || '').toLowerCase();
  const all = [...cand.skills.strong, ...cand.skills.working, ...cand.skills.learning];

  const strong = cand.skills.strong.filter((s) => text.includes(s.toLowerCase())).length;
  const working = cand.skills.working.filter((s) => text.includes(s.toLowerCase())).length;
  const learning = cand.skills.learning.filter((s) => text.includes(s.toLowerCase())).length;

  // Weighted so that a job asking for what he already does well beats one asking for what he is
  // still learning, even when the raw keyword count is the same.
  const weighted = strong * 1.0 + working * 0.6 + learning * 0.3;
  const ceiling = Math.max(4, all.length * 0.25);
  const skillScore = Math.min(1, weighted / ceiling);

  // The track resolver already decided this is one of his roles; a longer title match means a more
  // specific one ("media buyer" beats "marketing").
  const t = job.track ? { matchLength: 0 } : null;
  const resolved = resolveTrack(title, cand);
  const titleHit = resolved ? Math.min(1, 0.6 + resolved.matchLength / 40) : 0;

  return 0.6 * skillScore + 0.4 * titleHit;
}

function salaryFit(job, cand) {
  // The band belongs to the track: $60k is a strong marketing offer and a weak senior-dev one, and
  // scoring both against one number told the owner nothing useful.
  const band = bandFor(job.track, cand);
  if (!job.salary_min) return 0.5;                       // unpublished: neutral, not punished
  const fx = band.fxToUSD || {};
  const rate = job.salary_currency === band.currency ? 1 : (fx[job.salary_currency] || 1);
  const per = job.salary_period === 'hour' ? 2080 : job.salary_period === 'month' ? 12 : 1;
  const lo = job.salary_min * rate * per;
  const hi = (job.salary_max || job.salary_min) * rate * per;
  const mid = (lo + hi) / 2;
  if (mid <= band.min) return 0.35;
  if (mid >= band.max) return 1;                         // at or above the ceiling is a good problem
  return 0.35 + 0.65 * ((mid - band.min) / (band.max - band.min));
}

function seniorityFit(job, cand) {
  const t = job.title.toLowerCase();
  if (/\b(graduate|junior|entry|intern-to|apprentice|new grad|associate)\b/.test(t)) return 1;
  if (/\bii\b|\b2\b/.test(t)) return 0.7;
  if (/\b(engineer|developer|analyst)\b/.test(t)) return 0.8;
  return 0.6;
}

function recency(job) {
  if (!job.posted_at) return 0.5;
  const days = (Date.now() - new Date(job.posted_at).getTime()) / 86400000;
  if (!Number.isFinite(days)) return 0.5;
  if (days <= 7) return 1;
  if (days <= 21) return 0.8;
  if (days <= 45) return 0.55;
  if (days <= 90) return 0.3;
  return 0.15;                                            // a 6-month-old post is usually filled
}

export function scoreJob(job, cand) {
  const w = cand.scoring.weights;
  const parts = {
    roleFit: roleFit(job, cand),
    companyTier: TIER_POINTS[job.company_tier] ?? 0.4,
    salaryFit: salaryFit(job, cand),
    seniorityFit: seniorityFit(job, cand),
    recency: recency(job),
  };
  const total = Object.entries(w).reduce((sum, [k, weight]) => sum + (parts[k] ?? 0) * weight, 0);
  return { score: Math.round(total), parts };
}

function main() {
  const cand = JSON.parse(readFileSync(join(CONFIG, 'candidate.json'), 'utf8'));
  const d = db();
  const one = arg('job');

  const rows = one
    ? d.prepare('SELECT * FROM jobs WHERE id = ?').all(Number(one))
    : d.prepare(`SELECT * FROM jobs WHERE eligibility='yes' AND status='screened'${flag('all') ? '' : ' AND score IS NULL'}`).all();

  if (!rows.length) { console.log('Nothing to score.'); return; }

  const upd = d.prepare('UPDATE jobs SET score=?, status=?, updated_at=? WHERE id=?');
  const min = cand.scoring.minScoreToShortlist;
  let shortlisted = 0;

  const scored = rows.map((job) => {
    const { score, parts } = scoreJob(job, cand);
    const status = score >= min ? 'shortlisted' : 'screened';
    if (status === 'shortlisted') shortlisted++;
    upd.run(score, status, now(), job.id);
    return { job, score, parts, status };
  }).sort((a, b) => b.score - a.score);

  console.log(`Scored ${scored.length}. ${shortlisted} cleared the shortlist bar of ${min}.\n`);
  for (const { job, score, parts, status } of scored.slice(0, 25)) {
    const bits = Object.entries(parts).map(([k, v]) => `${k[0]}${Math.round(v * 100)}`).join(' ');
    console.log(`  ${String(score).padStart(3)} ${status === 'shortlisted' ? '*' : ' '} ${(job.company || '?').slice(0, 18).padEnd(19)} ${job.title.slice(0, 46).padEnd(48)} ${bits}`);
  }
  logEvent('score_run', { scored: scored.length, shortlisted });
  console.log(`\nLegend: r=role fit, c=company tier, s=salary, s=seniority, r=recency (0-100 each)`);
}

if (process.argv[1] && process.argv[1].endsWith('score.mjs')) main();
