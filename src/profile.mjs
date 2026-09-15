// Per-user configuration.
//
// Before multi-user, "the profile" was three files on disk: config/candidate.json,
// data/resume/master.json and config/money.json. Ten modules read them directly. This module is
// the seam: it serves the same three objects, from the database, for whichever user is asking —
// and falls back to the files when no profile row exists, so every existing CLI keeps working
// exactly as it did.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, db, now } from './db.mjs';

const FILES = {
  candidate: join(ROOT, 'config', 'candidate.json'),
  master: join(ROOT, 'data', 'resume', 'master.json'),
  money: join(ROOT, 'config', 'money.json'),
};

const readFile = (which) => (existsSync(FILES[which]) ? JSON.parse(readFileSync(FILES[which], 'utf8')) : null);

/** The template a brand-new account starts from: structure intact, nothing personal. */
export function starterProfile() {
  const base = readFile('candidate') || {};
  return {
    ...base,
    identity: {
      name: '', email: '', phone: '', linkedin: '',
      basedIn: '', timezone: '',
      workAuthorization: 'Where you can legally work, and whether you need sponsorship.',
    },
    _new: true,
  };
}

/**
 * A user's three config objects.
 *
 * userId 0 means "no particular user" and reads the files, which is what every CLI does. That keeps
 * `npm run hunt` working on the owner's own machine without an account.
 */
export function profileFor(userId = 0) {
  if (!userId) {
    return { candidate: readFile('candidate'), master: readFile('master'), money: readFile('money') };
  }
  const row = db().prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  if (!row) {
    return { candidate: starterProfile(), master: { skills: {}, experience: [], projects: [], education: [] }, money: readFile('money') };
  }
  return {
    candidate: JSON.parse(row.candidate_json),
    master: row.master_json ? JSON.parse(row.master_json) : { skills: {}, experience: [], projects: [], education: [] },
    money: row.money_json ? JSON.parse(row.money_json) : readFile('money'),
  };
}

export function saveProfile(userId, { candidate, master, money } = {}) {
  const current = profileFor(userId);
  const next = {
    candidate: candidate ?? current.candidate,
    master: master ?? current.master,
    money: money ?? current.money,
  };
  db().prepare(`
    INSERT INTO profiles (user_id, candidate_json, master_json, money_json, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      candidate_json=excluded.candidate_json,
      master_json=excluded.master_json,
      money_json=excluded.money_json,
      updated_at=excluded.updated_at
  `).run(userId, JSON.stringify(next.candidate), JSON.stringify(next.master),
         next.money ? JSON.stringify(next.money) : null, now());
  return next;
}

/** Has this user given the system enough to screen jobs for them? */
export function profileReadiness(userId) {
  const { candidate, master } = profileFor(userId);
  const tracks = Object.entries(candidate?.tracks || {}).filter(([, t]) => t.enabled !== false);
  const facts = (master?.experience?.length || 0) + (master?.projects?.length || 0);
  const missing = [];
  if (!candidate?.identity?.name) missing.push('your name');
  if (!candidate?.identity?.basedIn) missing.push('where you are based');
  if (!candidate?.identity?.workAuthorization) missing.push('your work authorisation');
  if (!tracks.length) missing.push('at least one role track');
  if (!facts) missing.push('a resume to build applications from');
  return { ready: missing.length === 0, missing, tracks: tracks.map(([k]) => k), facts };
}
