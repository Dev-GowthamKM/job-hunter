#!/usr/bin/env node
// The scout: runs every enabled source, dedupes, and writes new leads into the pipeline.
//
//   node src/scout.mjs                          all enabled sources
//   node src/scout.mjs --source=hn              just one
//   node src/scout.mjs --source=osm --city=london
//   node src/scout.mjs --dry-run                print what it found, write nothing
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, upsertLead, logEvent, isSuppressed, db } from './db.mjs';

const SOURCES = { hn: './sources/hn.mjs', remoteok: './sources/remoteok.mjs', wwr: './sources/wwr.mjs', osm: './sources/osm.mjs', reddit: './sources/reddit.mjs' };

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'targets.json'), 'utf8'));
  const dryRun = flag('dry-run');
  const only = arg('source');
  const city = arg('city');

  const names = only ? [only] : Object.keys(SOURCES).filter((n) => cfg.sources[n]?.enabled);
  if (only && !SOURCES[only]) {
    console.error(`Unknown source "${only}". Known: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }

  console.log(`Scout run${dryRun ? ' (dry run, nothing will be written)' : ''} — sources: ${names.join(', ')}\n`);
  const summary = [];
  let totalNew = 0;

  for (const name of names) {
    if (only && !cfg.sources[name]?.enabled) {
      console.log(`  ${name}: disabled in config, running anyway because you asked for it explicitly`);
    }
    const started = Date.now();
    let found = [];
    try {
      const mod = await import(SOURCES[name]);
      found = await mod.collect(cfg, { city });
    } catch (err) {
      console.log(`  ${name.padEnd(9)} ERROR  ${err.message}`);
      logEvent('scout_error', `${name}: ${err.message}`);
      summary.push({ name, found: 0, inserted: 0, error: err.message });
      continue;
    }

    // Per source, not a shared pool: HN alone returns 200+ posts a month and would otherwise
    // consume the whole run's budget before the other sources are even reached.
    const budget = cfg.maxLeadsPerSource ?? 40;
    let inserted = 0, duplicates = 0, suppressed = 0;

    for (const lead of found.slice(0, budget)) {
      if (isSuppressed(lead.company, lead.contact, lead.url)) { suppressed++; continue; }
      if (dryRun) { inserted++; continue; }
      const { result } = upsertLead(lead);
      if (result === 'inserted') inserted++; else duplicates++;
    }
    totalNew += inserted;

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${name.padEnd(9)} found ${String(found.length).padStart(4)}  new ${String(inserted).padStart(3)}  dup ${String(duplicates).padStart(3)}  suppressed ${suppressed}  (${secs}s)`);
    summary.push({ name, found: found.length, inserted, duplicates, suppressed });

    if (dryRun) {
      for (const l of found.slice(0, 5)) {
        console.log(`      [${l.raw?.relevance ?? '-'}] ${l.raw?.suggestedOffer ?? '-'} | ${l.title.slice(0, 78)}`);
      }
    }
  }

  if (!dryRun) {
    logEvent('scout_run', summary);
    const open = db().prepare("SELECT COUNT(*) n FROM leads WHERE status='new'").get().n;
    console.log(`\n${totalNew} new leads written. ${open} total awaiting qualification.`);
    console.log(`Next: run /ceo in Claude Code to qualify, research and draft.`);
  } else {
    console.log(`\nDry run complete. ${totalNew} leads would have been written.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
