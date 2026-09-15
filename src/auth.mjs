// Accounts and sessions, on node:crypto alone.
//
// Passwords are hashed with scrypt and a per-user salt, compared in constant time, and never
// logged, never returned by any API, and never stored in a session. A session token is random
// bytes with no relationship to the password, so a leaked token cannot be turned back into one.
import { randomBytes, randomUUID, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, now } from './db.mjs';

const scrypt = promisify(_scrypt);

// Deliberately slow. The cost is paid once per login and is what makes a stolen hash table
// expensive to attack; tuning this down to speed up sign-in is a false economy.
const KEYLEN = 64;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, KEYLEN, SCRYPT);
  return { hash: key.toString('hex'), salt };
}

export async function verifyPassword(password, hash, salt) {
  const key = await scrypt(password, salt, KEYLEN, SCRYPT);
  const stored = Buffer.from(hash, 'hex');
  // Length check first: timingSafeEqual throws on a mismatch, and that throw is itself a signal.
  if (stored.length !== key.length) return false;
  return timingSafeEqual(stored, key);
}

/** What a password has to clear. Short and honest beats a wall of rules nobody reads. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  if (/^\d+$/.test(password)) return 'Digits alone are guessed in seconds. Add words.';
  if (/^(password|12345|qwerty|letmein|welcome)/i.test(password)) return 'That is one of the first passwords anyone tries.';
  return null;
}

export function emailProblem(email) {
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email.trim())) return 'That does not look like an email address.';
  if (email.length > 254) return 'That email is too long.';
  return null;
}

// ---------------------------------------------------------------------------

export async function createUser({ email, password, name }) {
  const e = String(email || '').trim().toLowerCase();
  const bad = emailProblem(e) || passwordProblem(password);
  if (bad) throw Object.assign(new Error(bad), { userFacing: true });

  const D = db();
  if (D.prepare('SELECT id FROM users WHERE email = ?').get(e)) {
    throw Object.assign(new Error('There is already an account with that email.'), { userFacing: true });
  }
  const { hash, salt } = await hashPassword(password);
  const info = D.prepare(`INSERT INTO users (email, name, password_hash, password_salt, created_at)
                          VALUES (?,?,?,?,?)`).run(e, name || null, hash, salt, now());
  return Number(info.lastInsertRowid);
}

export async function authenticate(email, password) {
  const e = String(email || '').trim().toLowerCase();
  const user = db().prepare('SELECT * FROM users WHERE email = ?').get(e);

  // Hash even when the account does not exist, so a missing email and a wrong password take the
  // same time. Otherwise the response time is an account-enumeration oracle.
  if (!user) { await hashPassword(String(password || 'x'), 'decoy-salt-0000'); return null; }
  if (user.status !== 'active') return null;

  const ok = await verifyPassword(String(password || ''), user.password_hash, user.password_salt);
  if (!ok) return null;
  db().prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);
  return { id: user.id, email: user.email, name: user.name };
}

export function startSession(userId, userAgent = null) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db().prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
      .run(token, userId, now(), expires, userAgent);
  return { token, expires };
}

export function userForToken(token) {
  if (!token) return null;
  const row = db().prepare(`
    SELECT u.id, u.email, u.name, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.status = 'active'`).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) { endSession(token); return null; }
  return { id: row.id, email: row.email, name: row.name };
}

export function endSession(token) {
  if (token) db().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Sessions that have aged out. Called on boot so the table does not grow without bound. */
export function pruneSessions() {
  return db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes;
}

// ---------------------------------------------------------------------------
// Rate limiting. In memory on purpose: a restart clearing it is acceptable, and it avoids a
// write to the database on every failed guess.
// ---------------------------------------------------------------------------

const attempts = new Map();

export function tooManyAttempts(key, { max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const now_ = Date.now();
  const hits = (attempts.get(key) || []).filter((t) => now_ - t < windowMs);
  attempts.set(key, hits);
  return hits.length >= max;
}

export function recordAttempt(key) {
  const hits = attempts.get(key) || [];
  hits.push(Date.now());
  attempts.set(key, hits);
}

export function clearAttempts(key) { attempts.delete(key); }
