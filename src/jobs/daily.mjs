#!/usr/bin/env node
// One day's work, in the order it has to happen.
//
//   node src/jobs/daily.mjs
//
// A hunt collects and screens, but it does not score, so running it alone leaves the new postings
// in the database with no position in the ranking - present, but at the bottom of every list. This
// runs the two steps in order and records one event for the pair, so the dashboard can say when
// the last full update was rather than when the last half of one was.
//
// It collects. It does not apply, and it must never apply: the approval gate is the whole point of
// this system and a scheduled task is exactly the wrong place to weaken it. Waking up to twenty
// sent applications is the failure this is shaped to prevent.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent } from '../db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const step = (label, args) => {
  const started = Date.now();
  console.log(`\n=== ${label} — ${new Date().toISOString()} ===`);
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', ...args],
    { cwd: ROOT, stdio: 'inherit' });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`=== ${label}: ${r.status === 0 ? 'ok' : `FAILED (exit ${r.status})`} in ${secs}s ===`);
  return { ok: r.status === 0, secs };
};

const hunt = step('hunt', ['src/jobs/hunt.mjs']);
// Score even if the hunt failed partway: it may still have stored something before it broke, and
// half a collection scored is more useful than half a collection ignored.
const score = step('score', ['src/jobs/score.mjs']);

logEvent('daily_run', { hunt: hunt.ok, huntSecs: hunt.secs, score: score.ok, scoreSecs: score.secs });
console.log(`\nDaily update ${hunt.ok && score.ok ? 'complete' : 'finished with errors'}.`);
process.exit(hunt.ok && score.ok ? 0 : 1);
