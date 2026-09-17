#!/usr/bin/env node
// Layer 2 of the eligibility filter, run without a human in the room.
//
//   node src/jobs/adjudicate.mjs                 rule on everything sitting at 'unclear'
//   node src/jobs/adjudicate.mjs --limit=20      stop after 20
//   node src/jobs/adjudicate.mjs --dry-run       show the rulings, write nothing
//
// The deterministic filter in eligibility.mjs settles the obvious cases for free. What survives is
// the residue: postings that never said where the person has to be. Silence is the whole question,
// and it is a reading task, not a pattern-matching one - which is why this bucket sat at 74 with
// nothing processing it until now.
//
// THE SAME LAW APPLIES HERE. This records a verdict and nothing else. It cannot apply, cannot send
// and cannot approve. A model reading job descriptions overnight is useful; a model deciding to
// submit an application on someone's behalf is the failure this whole system is built to prevent.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, CONFIG, db, now, logEvent, setJobVerdict } from '../db.mjs';

// launchd does not inherit a shell environment, so the key cannot come from .zshrc - the scheduled
// run would silently have no key and skip layer 2 every night. It has to be in .env.
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) { try { process.loadEnvFile(envPath); } catch { /* Node < 21 */ } }

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ADJUDICATE_MODEL || 'claude-sonnet-5';
const LIMIT = Number(arg('limit', 40));
const DRY = flag('dry-run');

// No key is not an error. The daily run calls this, and a missing key should mean "skip the
// optional step", not "the nightly collection failed".
if (!KEY) {
  console.log('No ANTHROPIC_API_KEY set, so layer 2 is off. The unclear pile stays unclear.');
  console.log('Add it to .env to turn this on. Everything else works without it.');
  process.exit(0);
}

const D = db();
const cand = JSON.parse(readFileSync(join(CONFIG, 'candidate.json'), 'utf8'));
const jobs = D.prepare(`SELECT id, company, title, url, location_raw, remote_detail, content
                        FROM jobs WHERE eligibility = 'unclear' AND hidden = 0
                        ORDER BY COALESCE(score, 0) DESC, id DESC LIMIT ?`).all(LIMIT);

if (!jobs.length) { console.log('Nothing at unclear. Layer 1 decided everything.'); process.exit(0); }

const basedIn = cand.identity?.basedIn || cand.identity?.location || 'unknown';
const auth = cand.identity?.workAuthorization || 'unknown';
const mode = cand.eligibility?.mode || 'global-only';

const SYSTEM = `You decide one thing about a job posting: could this candidate actually take this job?

The candidate lives in ${basedIn}. Their work authorization is: ${auth}.
Their setting is "${mode}", which means they need a role they can do from where they are, without
relocating and without a visa the employer would have to sponsor.

A deterministic filter has already rejected the obvious cases. What reaches you is the residue:
postings that never stated a location requirement. That silence is the whole question.

Rule as follows:
- "yes"     the posting states, or its own wording clearly shows, that it hires with no country
            restriction.
- "no"      any country, region, timezone or work-authorization requirement - including one you
            infer from strong evidence in the text. Say what the evidence was.
- "unclear" you genuinely cannot tell from the text. This is a real answer, but it means the job
            will not be researched, so do not reach for it to avoid deciding.

SILENCE IS NOT PERMISSION. A posting that says nothing about location is far more often a domestic
role that forgot to mention it than a globally open one. Default to "no" when there is no remote
language anywhere in the posting.

Never rule "yes" because the role is attractive. Wanting it is not evidence.

You MUST quote the posting. Copy the exact sentence or phrase that decided it into "quote". If
nothing in the posting speaks to location at all, set quote to "" and say so in the reason - that
absence is itself the evidence, and the reason must state it plainly.

Reply with JSON only, no prose and no code fence:
{"verdict":"yes|no|unclear","quote":"<exact text from the posting, or empty>","reason":"<one sentence>"}`;

async function ask(job) {
  const body = {
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Company: ${job.company || 'unknown'}
Title: ${job.title}
Location field: ${job.location_raw || '(the board gave none)'}
Remote detail: ${job.remote_detail || '(none)'}

Posting:
${(job.content || '').slice(0, 14000)}`,
    }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const out = JSON.parse(clean);
  if (!['yes', 'no', 'unclear'].includes(out.verdict)) throw new Error(`bad verdict "${out.verdict}"`);
  return { ...out, usage: j.usage || {} };
}

const tally = { yes: 0, no: 0, unclear: 0, failed: 0, inTok: 0, outTok: 0 };
console.log(`Layer 2: ${jobs.length} postings at unclear, model ${MODEL}${DRY ? ' (dry run)' : ''}\n`);

for (const job of jobs) {
  let v;
  try {
    v = await ask(job);
  } catch (e) {
    tally.failed++;
    console.log(`  !! ${String(job.id).padEnd(6)} ${(job.company || '?').slice(0, 18).padEnd(20)} ${e.message.slice(0, 70)}`);
    continue;
  }
  tally[v.verdict]++;
  tally.inTok += v.usage.input_tokens || 0;
  tally.outTok += v.usage.output_tokens || 0;

  // The quote is the whole point of layer 1 and it is the whole point here too. A ruling with an
  // empty quote is only acceptable when the model is saying the posting is silent, and the reason
  // has to carry that; anything else is a verdict nobody can check later.
  const reason = v.quote
    ? `${v.reason} — "${String(v.quote).slice(0, 220)}"`
    : `${v.reason} (the posting never mentions location)`;

  console.log(`  ${v.verdict.padEnd(8)} ${String(job.id).padEnd(6)} ${(job.company || '?').slice(0, 18).padEnd(20)} ${job.title.slice(0, 40)}`);
  if (!DRY) {
    setJobVerdict(job.id, {
      eligibility: v.verdict,
      reason,
      layer: 'agent',
      status: v.verdict === 'yes' ? 'shortlisted' : v.verdict === 'no' ? 'rejected' : 'screened',
    });
  }
}

// Sonnet 5 list pricing at the time of writing, in dollars per million tokens. Printed so the bill
// is visible per run rather than discovered at the end of the month.
const cost = (tally.inTok / 1e6) * 3 + (tally.outTok / 1e6) * 15;
console.log(`\n  eligible ${tally.yes}   rejected ${tally.no}   still unclear ${tally.unclear}   failed ${tally.failed}`);
console.log(`  ${tally.inTok.toLocaleString()} in / ${tally.outTok.toLocaleString()} out tokens  ≈ $${cost.toFixed(3)}`);

if (!DRY) logEvent('adjudicate_run', { ...tally, model: MODEL, costUsd: Number(cost.toFixed(4)) });

// A run where every single call failed is a failure, and the nightly log should say so. One or two
// failures out of forty is a flaky request and not worth crying about; all of them is a wrong key,
// a dead network or a model name that no longer exists.
if (tally.failed === jobs.length) {
  console.error(`\nEvery request failed. Check ANTHROPIC_API_KEY in .env, and that "${MODEL}" is a current model.`);
  process.exit(1);
}
