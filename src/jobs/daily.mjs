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
import { logEvent, db } from '../db.mjs';

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

// Has today's collection already happened?
//
// This exists because StartCalendarInterval does not work on a laptop. The agent was set for 07:00
// and the Mac is shut at 07:00: launchd reported runs = 0 and the collection silently stopped for
// eight days while the dashboard went on saying "collecting every day at 07:00". A missed calendar
// job is supposed to fire on wake and did not.
//
// So the agent now asks every couple of hours instead, and this is what stops that becoming eight
// crawls a day. The database is the source of truth rather than a timestamp file, because the
// database is the thing that would actually have the postings.
const ranToday = () => {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  return db().prepare(
    "SELECT COUNT(*) n FROM events WHERE kind = 'daily_run' AND at >= ?").get(since.toISOString()).n > 0;
};

const FORCE = process.argv.includes('--force');
const AFTER_HOUR = Number(process.env.DAILY_AFTER_HOUR || 7);

if (!FORCE) {
  if (ranToday()) {
    console.log(`Already collected today. Nothing to do. (--force overrides.)`);
    process.exit(0);
  }
  if (new Date().getHours() < AFTER_HOUR) {
    console.log(`Before ${String(AFTER_HOUR).padStart(2, '0')}:00 local, so holding off. Will try again on the next wake-up.`);
    process.exit(0);
  }
}

const hunt = step('hunt', ['src/jobs/hunt.mjs']);
// Score even if the hunt failed partway: it may still have stored something before it broke, and
// half a collection scored is more useful than half a collection ignored.
const score = step('score', ['src/jobs/score.mjs']);

// Layer 2: read the postings layer 1 could not decide. Costs money, so it is capped per run and
// skips itself entirely when no API key is set. Its failure must never fail the night - the
// collection is the part that cannot be redone later, and this can always be run again by hand.
const judge = step('adjudicate', ['src/jobs/adjudicate.mjs', '--limit=40']);

logEvent('daily_run', { hunt: hunt.ok, huntSecs: hunt.secs, score: score.ok, scoreSecs: score.secs,
                        adjudicate: judge.ok, adjudicateSecs: judge.secs });
const core = hunt.ok && score.ok;
console.log(`\nDaily update ${core ? 'complete' : 'finished with errors'}${core && !judge.ok ? ', but layer 2 failed' : ''}.`);
process.exit(core ? 0 : 1);
