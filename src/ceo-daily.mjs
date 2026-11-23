#!/usr/bin/env node
// One day's client collection, in the order it has to happen.
//
//   node src/ceo-daily.mjs
//
// What it does: scouts the next district in the rotation and reports what is waiting.
//
// What it deliberately does NOT do: qualify, research, draft, or send. Those four need an agent
// reading real pages and making judgements, and the two that matter most were each saved by one.
// The researcher caught a business that every aggregator still lists as open and which has been
// shut since February 2025; it caught another whose brand had been replaced at the same address.
// A nightly script cannot do that, and a nightly script that pretended to would quietly turn the
// pipeline back into the spam machine the approval gate exists to prevent.
//
// So this collects, and leaves a worklist. `/ceo` in Claude Code does the thinking.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, logEvent } from './db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = db();

const step = (label, args) => {
  const started = Date.now();
  console.log(`\n=== ${label} — ${new Date().toISOString()} ===`);
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', ...args],
    { cwd: ROOT, stdio: 'inherit' });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`=== ${label}: ${r.status === 0 ? 'ok' : `FAILED (exit ${r.status})`} in ${secs}s ===`);
  return { ok: r.status === 0, secs };
};

const before = D.prepare("SELECT COUNT(*) n FROM leads").get().n;
// One district per run. OSM is slow by nature (a single category clause measured 65 seconds on the
// public mirror) and the rotation covers the whole of Bengaluru over a week rather than hammering
// a free service for all of it every night.
const scout = step('scout', ['src/scout.mjs']);
const after = D.prepare("SELECT COUNT(*) n FROM leads").get().n;

const waiting = {
  unjudged: D.prepare("SELECT COUNT(*) n FROM leads WHERE status='new'").get().n,
  qualified: D.prepare("SELECT COUNT(*) n FROM leads WHERE status='qualified'").get().n,
  researched: D.prepare("SELECT COUNT(*) n FROM leads WHERE status='researched'").get().n,
  drafts: D.prepare("SELECT COUNT(*) n FROM messages WHERE status='draft'").get().n,
  unverified: D.prepare("SELECT COUNT(*) n FROM messages WHERE status='sent' AND delivery='claimed'").get().n,
};

logEvent('ceo_daily', { found: after - before, scoutOk: scout.ok, ...waiting });

console.log(`\n${after - before} new businesses collected.`);
console.log(`Waiting for an agent: ${waiting.unjudged} unjudged, ${waiting.qualified} to research, ${waiting.researched} to draft.`);
console.log(`Waiting for you: ${waiting.drafts} draft${waiting.drafts === 1 ? '' : 's'}${waiting.unverified ? `, ${waiting.unverified} send${waiting.unverified === 1 ? '' : 's'} unconfirmed` : ''}.`);
console.log(`\nRun /ceo in Claude Code to judge and draft. Nothing here contacts anybody.`);
process.exit(scout.ok ? 0 : 1);
