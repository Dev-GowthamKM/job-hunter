#!/usr/bin/env node
// First-run setup. The thing a friend runs once, before anything else.
//
// A fresh clone has no config/candidate.json - it is gitignored, because it holds a real name,
// salary expectations and work-authorisation status. Without it the first command a new user tries
// dies on a stack trace, which is a terrible way to meet a project. This creates it, asks the four
// things the screener genuinely cannot work without, and stops.
//
//   npm run setup
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ROOT } from './db.mjs';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, fallback = '') => {
  const a = (await rl.question(q)).trim();
  return a || fallback;
};

const P = (f) => join(ROOT, f);

console.log('\n  Job Hunter setup\n  ' + '-'.repeat(48) + '\n');

// 1. Files and folders -------------------------------------------------------
for (const dir of ['data', 'data/resume', 'data/applications', 'data/uploads', 'outbox']) {
  mkdirSync(P(dir), { recursive: true });
}
for (const [example, real] of [
  ['config/candidate.example.json', 'config/candidate.json'],
  ['config/money.example.json', 'config/money.json'],
]) {
  if (!existsSync(P(real)) && existsSync(P(example))) {
    copyFileSync(P(example), P(real));
    console.log(`  created ${real}`);
  }
}

const cfgPath = P('config/candidate.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const already = cfg.identity?.name && cfg.identity.name !== 'Your Name';
if (already) {
  console.log(`\n  ${cfg.identity.name} is already set up. Re-running will overwrite that.\n`);
  const go = await ask('  Continue? [y/N] ', 'n');
  if (!/^y/i.test(go)) { console.log('  Left alone.\n'); rl.close(); process.exit(0); }
}

// 2. The four things the screener cannot work without ------------------------
console.log('\n  Four questions. All of this stays on your machine.\n');

const name = await ask('  Your name: ');
const email = await ask('  Email (goes on the resume): ');
const basedIn = await ask('  Where are you based? (e.g. Lisbon, Portugal): ');

console.log('\n  Work authorisation decides which jobs are reachable, so be accurate.');
console.log('  e.g. "India. No US/EU work authorisation, no sponsorship in hand."');
const workAuthorization = await ask('  Your status: ');

// 3. Tracks ------------------------------------------------------------------
const trackKeys = Object.keys(cfg.tracks || {});
console.log('\n  Which kinds of role should it search? Comma-separated numbers.\n');
trackKeys.forEach((k, i) => console.log(`    ${i + 1}. ${cfg.tracks[k].label || k}`));
const picked = await ask('\n  Tracks [1]: ', '1');
const chosen = new Set(
  picked.split(',').map((n) => trackKeys[Number(n.trim()) - 1]).filter(Boolean),
);
if (!chosen.size) chosen.add(trackKeys[0]);
for (const k of trackKeys) cfg.tracks[k].enabled = chosen.has(k);

// 4. Reach -------------------------------------------------------------------
console.log('\n  How wide should the search be?\n');
console.log('    1. Only jobs open to anyone, anywhere (strictest - few results)');
console.log('    2. Also jobs open to your region');
const reach = await ask('\n  Reach [2]: ', '2');
cfg.eligibility.mode = reach.trim() === '1' ? 'global-only' : 'global-plus-india';

cfg.identity = { ...cfg.identity, name, email, basedIn, workAuthorization, phone: cfg.identity?.phone || '' };
delete cfg._new;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

// 5. Resume ------------------------------------------------------------------
console.log('\n  ' + '-'.repeat(48));
console.log('\n  Saved to config/candidate.json. Edit it any time.\n');

const masterPath = P('data/resume/master.json');
if (!existsSync(masterPath)) {
  console.log('  Last thing: the resume. Applications are built only from facts it can');
  console.log('  find in your resume, so without one it can search but not apply.\n');
  const resume = await ask('  Path to a PDF or DOCX (or press enter to skip): ');
  if (resume) {
    const clean = resume.replace(/^['"]|['"]$/g, '').replace(/^~/, process.env.HOME || '~');
    if (existsSync(clean)) {
      const { addResume } = await import('./jobs/resume.mjs').catch(() => ({}));
      if (addResume) {
        try { await addResume(clean); console.log('  Resume read.'); }
        catch (e) { console.log(`  Could not read it: ${e.message}`); }
      }
    } else {
      console.log(`  No file at ${clean}. Add it later with: npm run resume add <path>`);
    }
  }
}

console.log('\n  ' + '-'.repeat(48));
console.log('\n  Ready. Two commands:\n');
console.log('    npm run hunt     collect jobs  (a few minutes the first time)');
console.log('    npm run web      open the dashboard\n');
rl.close();
