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
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent, db } from '../db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// How much of this run the machine spent frozen.
//
// This exists because three runs were reported as taking 46, 79 and 87 minutes and I spent an
// afternoon looking for the slow source. There wasn't one. The 87-minute run started at 08:01:20
// inside an 11-second DarkWake, the Mac went back to sleep at 08:01:31, and the run finished at
// 09:28 - one minute after the lid was opened. Ninety seconds of work, 87 minutes of clock.
//
// A timer that is asked to fire every 15 seconds and does not fire for 50 minutes is the whole
// measurement. No special clock needed, and it is the reason this file waits on the child
// asynchronously instead of using spawnSync, which would block the event loop and the timer with
// it.
const BEAT_MS = 15000;
let frozenMs = 0;
let lastBeat = Date.now();
const heart = setInterval(() => {
  const gap = Date.now() - lastBeat;
  if (gap > BEAT_MS * 3) frozenMs += gap - BEAT_MS;   // slept, suspended, or starved of CPU
  lastBeat = Date.now();
}, BEAT_MS);
heart.unref();

const step = (label, args) => new Promise((resolve) => {
  const started = Date.now();
  console.log(`\n=== ${label} — ${new Date().toISOString()} ===`);
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', ...args],
    { cwd: ROOT, stdio: 'inherit' });
  child.on('close', (code) => {
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`=== ${label}: ${code === 0 ? 'ok' : `FAILED (exit ${code})`} in ${secs}s ===`);
    resolve({ ok: code === 0, code, secs });
  });
  child.on('error', (e) => {
    console.log(`=== ${label}: FAILED to start — ${e.message} ===`);
    resolve({ ok: false, code: -1, secs: 0 });
  });
});

/**
 * Is there actually a network?
 *
 * launchd starts this job inside macOS DarkWake maintenance windows, where the process is
 * scheduled but the machine is otherwise asleep and the network interface is not up. Four runs
 * collapsed that way: 2026-11-02 saw 0 postings with 71 errors, 2026-11-10 saw 1,344 against the
 * usual 12,000 with 44 "fetch failed". Every one of those errors said the same thing, and it was
 * not about the boards.
 *
 * A TCP connect, not a fetch: npm run injects twenty npm_config_* variables and undici reads proxy
 * settings out of the environment, which is exactly how a health probe once reported a live server
 * as dead. And not an HTTP request either - this needs to know whether the socket opens, which is
 * no load at all on the board.
 */
const reachable = (host, ms = 6000) => new Promise((resolve) => {
  const sock = connect({ host, port: 443 });
  const done = (ok) => { sock.destroy(); resolve(ok); };
  sock.setTimeout(ms, () => done(false));
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
});

// Two hosts, because one board being down is not the same as having no network.
const online = async () => (await Promise.all(
  ['boards-api.greenhouse.io', 'himalayas.app'].map((h) => reachable(h)))).some(Boolean);

// Has today's collection already happened, and did it work?
//
// This exists because StartCalendarInterval does not work on a laptop. The agent was set for 07:00
// and the Mac is shut at 07:00: launchd reported runs = 0 and the collection silently stopped for
// eight days while the dashboard went on saying "collecting every day at 07:00". A missed calendar
// job is supposed to fire on wake and did not.
//
// So the agent now asks every couple of hours instead, and this is what stops that becoming eight
// crawls a day. The database is the source of truth rather than a timestamp file, because the
// database is the thing that would actually have the postings.
//
// `healthy != 0` is not a detail. A DarkWake run finishes in a minute having seen almost nothing,
// and the first version of this guard counted it, so one broken run at dawn satisfied the day's
// quota and the real collection never ran. A run that did not see the boards does not count as
// having looked.
const ranToday = () => {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const rows = db().prepare(
    "SELECT detail FROM events WHERE kind = 'daily_run' AND at >= ?").all(since.toISOString());
  return rows.some((r) => {
    try { return JSON.parse(r.detail).healthy !== false; } catch { return true; }
  });
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
  if (!await online()) {
    console.log(`No network — not starting a crawl that would fail against every board.`);
    console.log(`This is normal: launchd runs this inside DarkWake maintenance windows where the`);
    console.log(`machine is awake enough to schedule a process and not awake enough to have wifi.`);
    console.log(`Trying again on the next tick. Today's collection has NOT been recorded.`);
    logEvent('daily_skipped', { reason: 'offline' });
    process.exit(0);
  }
}

// Keep an idle machine awake for the duration.
//
// It cannot beat a closed lid - clamshell sleep ignores every assertion - but it does stop the Mac
// idling out from under a crawl that is running with the lid open, which is the common case.
let caffeine = null;
try {
  caffeine = spawn('/usr/bin/caffeinate', ['-i', '-m', '-w', String(process.pid)],
    { detached: true, stdio: 'ignore' });
  caffeine.unref();
} catch { /* not fatal: the run just becomes interruptible again */ }

const wallT0 = Date.now();
const hunt = await step('hunt', ['src/jobs/hunt.mjs']);
// Score even if the hunt failed partway: it may still have stored something before it broke, and
// half a collection scored is more useful than half a collection ignored.
const score = await step('score', ['src/jobs/score.mjs']);

// Layer 2: read the postings layer 1 could not decide. Costs money, so it is capped per run and
// skips itself entirely when no API key is set. Its failure must never fail the night - the
// collection is the part that cannot be redone later, and this can always be run again by hand.
const judge = await step('adjudicate', ['src/jobs/adjudicate.mjs', '--limit=40']);

// hunt.mjs exits 2 when it ran to completion but did not see the boards properly. That is a
// different thing from a crash and from a good run, and it is the one that must not count as
// today's collection.
const collapsed = hunt.code === 2;
const healthy = hunt.ok && score.ok;
const wallSecs = Math.round((Date.now() - wallT0) / 1000);
const frozenSecs = Math.round(frozenMs / 1000);

logEvent('daily_run', {
  hunt: hunt.ok, huntSecs: hunt.secs, score: score.ok, scoreSecs: score.secs,
  adjudicate: judge.ok, adjudicateSecs: judge.secs,
  wallSecs, frozenSecs, workSecs: Math.max(0, wallSecs - frozenSecs),
  healthy: healthy && !collapsed, collapsed,
});

if (frozenSecs > 60) {
  console.log(`\nThe machine was asleep or suspended for ${Math.round(frozenSecs / 60)} of those ${Math.round(wallSecs / 60)} minutes.`);
  console.log(`About ${wallSecs - frozenSecs}s of that was actual work. A long run here is a shut lid, not a slow crawl.`);
}
if (collapsed) {
  console.log(`\nThis run did not see the boards properly, so it does NOT count as today's`);
  console.log(`collection. The next tick will try again.`);
}
console.log(`\nDaily update ${healthy ? 'complete' : 'finished with errors'}${healthy && !judge.ok ? ', but layer 2 failed' : ''}.`);
process.exit(healthy && !collapsed ? 0 : 1);
