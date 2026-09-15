#!/usr/bin/env node
// How the job-scout agent records a layer-2 ruling. Separate from hunt.mjs so an agent can write a
// verdict without the ability to run, re-screen or delete anything else.
//
//   node src/jobs/verdict.mjs --job=42 --eligible=no --reason="\"must be authorized to work in the US\""
//   node src/jobs/verdict.mjs --job=42 --reject --reason="role needs 6 years"
import { db, now, logEvent, setJobVerdict } from '../db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const id = Number(arg('job'));
const reason = arg('reason');
const eligible = flag('reject') ? 'no' : arg('eligible');

if (!id || !reason || !['yes', 'no', 'unclear'].includes(eligible)) {
  console.error('usage: node src/jobs/verdict.mjs --job=<id> --eligible=yes|no|unclear --reason="<quote the posting>"');
  process.exit(1);
}

const job = db().prepare('SELECT id, company, title FROM jobs WHERE id = ?').get(id);
if (!job) { console.error(`No job ${id}.`); process.exit(1); }

// A verdict with no evidence is not reviewable, so it is not accepted.
if (reason.trim().length < 15) {
  console.error('Reason too short. Quote the posting - the near-miss report is only as honest as this field.');
  process.exit(1);
}

setJobVerdict(id, {
  eligibility: eligible,
  reason,
  layer: 'agent',
  status: eligible === 'yes' ? 'screened' : 'rejected',
});
logEvent('job_verdict', `${id} ${eligible}: ${reason}`.slice(0, 300));
console.log(`[${id}] ${job.company} — ${job.title}\n  ${eligible.toUpperCase()}: ${reason}`);
