#!/usr/bin/env node
// Account management from the terminal.
//
// The password is read with the terminal's echo turned off, so it is never in an argument, never in
// shell history, and never passes through anything but this process. There is deliberately no
// --password flag: a flag would put it in `ps` output and in .zsh_history.
//
//   node src/users.mjs create --email=you@example.com --name="Your Name"
//   node src/users.mjs list
//   node src/users.mjs claim --email=you@example.com   # move the on-disk profile into an account
//   node src/users.mjs passwd --email=you@example.com
import { createInterface } from 'node:readline';
import { db, now } from './db.mjs';
import { createUser, hashPassword, passwordProblem } from './auth.mjs';
import { saveProfile, profileFor } from './profile.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);

/** Read a line with echo off, so nothing appears on screen and nothing is recorded. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const raw = !!process.stdin.isTTY;
    if (raw) process.stdin.setRawMode(true);
    let buf = '';
    const done = (value) => {
      if (raw) process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      rl.close();
      resolve(value);
    };
    const onData = (chunk) => {
      const s = String(chunk);
      if (s === '\n' || s === '\r' || s === CTRL_D) return done(buf);
      if (s === CTRL_C) { if (raw) process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      if (s === BACKSPACE || s === '\b') { buf = buf.slice(0, -1); return; }
      buf += s;
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function readPasswordTwice() {
  const a = await askHidden('  Password (min 10 characters, not shown): ');
  const problem = passwordProblem(a);
  if (problem) { console.error(`\n  ${problem}`); process.exit(1); }
  const b = await askHidden('  Again to confirm: ');
  if (a !== b) { console.error('\n  Those did not match.'); process.exit(1); }
  return a;
}

async function create() {
  const email = arg('email');
  if (!email) { console.error('usage: node src/users.mjs create --email=you@example.com [--name="Your Name"]'); process.exit(1); }
  const password = await readPasswordTwice();
  const id = await createUser({ email, password, name: arg('name') });
  console.log(`\n  Account ${id} created for ${email}.`);
  console.log('  Sign in at http://127.0.0.1:4321');
}

function list() {
  const rows = db().prepare(`
    SELECT u.id, u.email, u.name, u.created_at, u.last_seen, u.status,
           (SELECT COUNT(*) FROM user_jobs uj WHERE uj.user_id = u.id) jobs,
           (SELECT COUNT(*) FROM profiles p WHERE p.user_id = u.id) has_profile
    FROM users u ORDER BY u.id`).all();
  if (!rows.length) { console.log('No accounts yet.\n\n  node src/users.mjs create --email=you@example.com'); return; }
  console.log(`${rows.length} account${rows.length === 1 ? '' : 's'}\n`);
  for (const r of rows) {
    console.log(`  [${r.id}] ${r.email.padEnd(30)} ${(r.name || '').padEnd(18)} ${r.status}`);
    console.log(`       profile: ${r.has_profile ? 'set up' : 'NOT SET UP'} · screened jobs: ${r.jobs} · last seen ${r.last_seen ? r.last_seen.slice(0, 16) : 'never'}`);
  }
}

/**
 * Move the on-disk profile into an account and hand it the verdicts already computed against the
 * shared job pool. Everything collected before multi-user existed belongs to somebody.
 */
function claim() {
  const email = String(arg('email') || '').trim().toLowerCase();
  const user = db().prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) { console.error(`No account for ${email}. Create it first.`); process.exit(1); }

  const files = profileFor(0);
  if (!files.candidate) { console.error('No config/candidate.json on disk to claim.'); process.exit(1); }
  saveProfile(user.id, files);
  console.log(`  Profile moved into account ${user.id} (${email}).`);

  const D = db();
  const jobs = D.prepare(`SELECT id, track, tier, score, eligibility, eligibility_reason,
                                 eligibility_layer, status, hidden FROM jobs`).all();
  const ins = D.prepare(`
    INSERT INTO user_jobs (user_id, job_id, track, tier, score, eligibility, eligibility_reason,
                           eligibility_layer, status, hidden, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, job_id) DO NOTHING`);
  for (const j of jobs) {
    ins.run(user.id, j.id, j.track, j.tier, j.score, j.eligibility, j.eligibility_reason,
            j.eligibility_layer, j.status, j.hidden, now());
  }
  console.log(`  ${jobs.length} job verdicts copied to this account.`);
}

async function passwd() {
  const email = String(arg('email') || '').trim().toLowerCase();
  const user = db().prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) { console.error(`No account for ${email}.`); process.exit(1); }
  const password = await readPasswordTwice();
  const { hash, salt } = await hashPassword(password);
  db().prepare('UPDATE users SET password_hash=?, password_salt=? WHERE id=?').run(hash, salt, user.id);
  db().prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log('\n  Password changed. Every existing session was signed out.');
}

const cmd = process.argv[2];
const run = { create, list, claim, passwd }[cmd];
if (!run) {
  console.error('usage: node src/users.mjs <create|list|claim|passwd> [--email=...] [--name=...]');
  process.exit(1);
}
await run();
