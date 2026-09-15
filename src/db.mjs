// Single source of truth for the whole CEO agent system.
// Uses node:sqlite (built into Node 22+), so the pipeline has zero dependencies.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(ROOT, 'data', 'pipeline.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- hn | remoteok | wwr | osm | manual | reddit
  source_id     TEXT NOT NULL UNIQUE,       -- stable per-source key, this is what dedupes
  title         TEXT NOT NULL,
  url           TEXT,
  company       TEXT,
  contact       TEXT,                       -- email / form / phone / telegram, whatever is public
  location      TEXT,
  raw_json      TEXT,                       -- full source payload, so agents can re-read detail
  discovered_at TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new',-- new|qualified|rejected|researched|drafted|sent|replied|won|lost
  score         INTEGER,                    -- 0-100, set by the qualifier
  offer         TEXT,                       -- which of the three offers fits
  angle         TEXT,                       -- the specific hook, set by the researcher
  notes         TEXT,
  dedupe_key    TEXT,                       -- normalized company+role, catches the same job reposted
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_score  ON leads(score DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER REFERENCES leads(id),
  direction   TEXT NOT NULL,                -- in | out
  channel     TEXT NOT NULL,                -- telegram | email | manual
  chat_id     TEXT,                         -- telegram chat this belongs to
  subject     TEXT,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',-- draft|approved|sent|skipped|received|failed
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

CREATE TABLE IF NOT EXISTS conversations (
  chat_id     TEXT PRIMARY KEY,             -- telegram chat id of the client
  lead_id     INTEGER REFERENCES leads(id),
  display     TEXT,                         -- name/username as Telegram reports it
  state       TEXT NOT NULL DEFAULT 'open', -- open|awaiting_reply|qualified|closed
  last_seen   TEXT,
  summary     TEXT                          -- rolling context the closer maintains
);

CREATE TABLE IF NOT EXISTS suppression (
  pattern     TEXT PRIMARY KEY,             -- domain, email, or company name. Never contact.
  reason      TEXT,
  added_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  lead_id     INTEGER,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------------------
-- JOB HUNT (/hunt). Separate from leads on purpose: a lead is someone the owner
-- sells to, a job is someone the owner works for. Same database, opposite direction.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source             TEXT NOT NULL,          -- ashby | greenhouse | lever | remotive | remoteok | wwr | hn | manual
  source_id          TEXT NOT NULL UNIQUE,   -- stable per-source key, this is what dedupes
  company            TEXT,
  company_tier       TEXT,                   -- brand | funded-startup | watch | unknown
  title              TEXT NOT NULL,
  url                TEXT,
  apply_url          TEXT,
  location_raw       TEXT,                   -- exactly what the board said, never normalized away
  employment_type    TEXT,                   -- FullTime | Contract | PartTime | Intern | unknown
  remote_scope       TEXT,                   -- worldwide | region | country | onsite | unknown
  remote_detail      TEXT,                   -- "Remote (US)", "Worldwide", country list, whatever was found
  salary_min         INTEGER,
  salary_max         INTEGER,
  salary_currency    TEXT,
  salary_period      TEXT,                   -- year | month | hour
  salary_source      TEXT,                   -- structured | parsed | unknown
  posted_at          TEXT,
  content            TEXT,                   -- full JD as plain text, agents re-read this
  raw_json           TEXT,
  discovered_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'new',
    -- new|screened|rejected|shortlisted|researched|tailored|packaged|ready|applied|replied|closed
  score              INTEGER,                -- 0-100 fit score, set by the scorer
  eligibility        TEXT,                   -- yes | no | unclear
  eligibility_reason TEXT,                   -- WHY. This is what --near-miss prints.
  eligibility_layer  TEXT,                   -- rules | agent  (which layer decided)
  reject_reason      TEXT,
  track              TEXT,                   -- dev | ai | marketing | game  (config/candidate.json)
  tier               TEXT,                   -- match | stretch | regional | no  (see eligibility.tierOf)
  hidden             INTEGER NOT NULL DEFAULT 0,  -- owner dismissed it from the dashboard
  notes              TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_score       ON jobs(score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_eligibility ON jobs(eligibility);
-- Covering index for the near-miss view. Without it, ORDER BY company forces a sort that does a
-- random lookup per row into a table where each row carries ~6KB of job description: measured at
-- 9,800ms for 2,282 rows, against 35ms unsorted.
CREATE INDEX IF NOT EXISTS idx_jobs_elig_company ON jobs(eligibility, company, id);
-- Added before it hurt rather than after: the dashboard's default view filters on track and
-- eligibility and sorts by score, over a table heading for 20k+ rows.
CREATE INDEX IF NOT EXISTS idx_jobs_track ON jobs(track, eligibility, score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_tier ON jobs(tier, score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_hidden ON jobs(hidden);

CREATE TABLE IF NOT EXISTS applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES jobs(id),
  packet_dir        TEXT,
  resume_path       TEXT,
  cover_path        TEXT,
  research_path     TEXT,
  loom_script_path  TEXT,
  loom_slides_path  TEXT,
  ats_coverage      INTEGER,                 -- 0-100 keyword coverage of the JD
  status            TEXT NOT NULL DEFAULT 'building',
    -- building|awaiting_approval|ready|applied|withdrawn
  created_at        TEXT NOT NULL,
  approved_at       TEXT,                    -- set ONLY by the owner approving. Never by an agent.
  applied_at        TEXT,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

-- ---------------------------------------------------------------------------
-- MONEY (/money). Tracking and arithmetic only. Nothing here moves money.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS budget_months (
  month       TEXT PRIMARY KEY,              -- YYYY-MM
  allocated   REAL NOT NULL,                 -- what the owner assigned themselves this month
  currency    TEXT NOT NULL DEFAULT 'INR',
  opened_at   TEXT NOT NULL,
  closed_at   TEXT,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS envelopes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  month     TEXT NOT NULL REFERENCES budget_months(month),
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,                   -- need | want | save | invest
  planned   REAL NOT NULL DEFAULT 0,
  UNIQUE(month, name)
);
CREATE INDEX IF NOT EXISTS idx_envelopes_month ON envelopes(month);

CREATE TABLE IF NOT EXISTS transactions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  month     TEXT NOT NULL,
  at        TEXT NOT NULL,
  envelope  TEXT NOT NULL,
  amount    REAL NOT NULL,                   -- positive = spent, negative = refund/return
  note      TEXT,
  source    TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_transactions_month ON transactions(month);

-- ---------------------------------------------------------------------------
-- MULTI-USER. The job pool is shared; the judgement about a job is not.
--
-- A posting is a fact: title, company, salary, location. Those are the same for
-- everyone and live on the jobs table. Whether a posting is a match, a stretch or
-- out of reach depends entirely on whose profile it is screened against, so every
-- verdict lives on user_jobs instead. One collection run serves every user.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,          -- scrypt, salt stored alongside
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen     TEXT,
  status        TEXT NOT NULL DEFAULT 'active'   -- active | suspended
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,          -- random, never derived from the password
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Per-user configuration that used to be config/candidate.json and
-- data/resume/master.json on disk. One row per user, JSON columns so the shape
-- stays exactly what the existing modules already read.
CREATE TABLE IF NOT EXISTS profiles (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  candidate_json TEXT NOT NULL,
  master_json    TEXT,
  money_json     TEXT,
  updated_at     TEXT NOT NULL
);

-- One row per (user, job): everything that is an opinion rather than a fact.
CREATE TABLE IF NOT EXISTS user_jobs (
  user_id            INTEGER NOT NULL REFERENCES users(id),
  job_id             INTEGER NOT NULL REFERENCES jobs(id),
  track              TEXT,
  tier               TEXT,
  score              INTEGER,
  eligibility        TEXT,
  eligibility_reason TEXT,
  eligibility_layer  TEXT,
  status             TEXT NOT NULL DEFAULT 'new',
  hidden             INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_user_jobs_tier ON user_jobs(user_id, tier, score DESC);
CREATE INDEX IF NOT EXISTS idx_user_jobs_status ON user_jobs(user_id, status);

CREATE TABLE IF NOT EXISTS money_goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  target     REAL NOT NULL,
  saved      REAL NOT NULL DEFAULT 0,
  by_date    TEXT,
  created_at TEXT NOT NULL,
  note       TEXT
);
`;

let _db;
export function db() {
  if (!_db) {
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL;');
    // On an existing database an index over a newly-added column fails before migrate() can add it,
    // and that takes the whole schema statement down with it. So: create what we can, migrate, then
    // run the schema again now that every column exists.
    try { _db.exec(SCHEMA); } catch { /* expected on an older database; migrate() fixes it */ }
    migrate(_db);
    _db.exec(SCHEMA);
    // Migration for databases created before dedupe_key existed, then the index, in that order.
    const cols = _db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
    if (!cols.includes('dedupe_key')) _db.exec('ALTER TABLE leads ADD COLUMN dedupe_key TEXT');
    _db.exec('CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(dedupe_key)');
  }
  return _db;
}

/**
 * Columns added after a database already exists. CREATE TABLE IF NOT EXISTS silently does nothing
 * for a table that is already there, so a new column has to be ALTERed in or every existing install
 * breaks on the next query that mentions it.
 */
function migrate(d) {
  const cols = d.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  const added = [
    ['track', 'TEXT'],
    ['hidden', 'INTEGER NOT NULL DEFAULT 0'],
    ['tier', 'TEXT'],
  ];
  for (const [name, ddl] of added) {
    if (!cols.includes(name)) d.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${ddl}`);
  }
}

export const now = () => new Date().toISOString();

/** A content fingerprint, so the same job reposted under a new id is caught.
 *  Verified case: Clad posted the identical role in both the August and September HN threads,
 *  which are two different comments and therefore two different source_ids. */
export function dedupeKey(lead) {
  const head = `${lead.company || ''} ${String(lead.title || '').split('|')[1] || lead.title || ''}`;
  const norm = head.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 48);
  return norm.length >= 12 ? `${lead.source}:${norm}` : null;   // too short to be distinctive
}

export function logEvent(kind, detail = '', leadId = null) {
  db().prepare('INSERT INTO events (at, kind, lead_id, detail) VALUES (?,?,?,?)')
      .run(now(), kind, leadId, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

/** Insert a scouted lead. Returns 'inserted' or 'duplicate'. Dedupe is on source_id. */
export function upsertLead(lead) {
  const d = db();
  const existing = d.prepare('SELECT id FROM leads WHERE source_id = ?').get(lead.source_id);
  if (existing) return { result: 'duplicate', id: existing.id };

  const key = dedupeKey(lead);
  if (key) {
    const twin = d.prepare('SELECT id FROM leads WHERE dedupe_key = ?').get(key);
    if (twin) return { result: 'duplicate', id: twin.id };
  }

  const info = d.prepare(`
    INSERT INTO leads (source, source_id, title, url, company, contact, location, raw_json, discovered_at, status, dedupe_key, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'new',?,?)
  `).run(
    lead.source, lead.source_id, lead.title, lead.url ?? null, lead.company ?? null,
    lead.contact ?? null, lead.location ?? null,
    lead.raw ? JSON.stringify(lead.raw) : null, now(), key, now()
  );
  return { result: 'inserted', id: Number(info.lastInsertRowid) };
}

export function setState(key, value) {
  db().prepare('INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
}
export function getState(key, fallback = null) {
  return db().prepare('SELECT value FROM state WHERE key = ?').get(key)?.value ?? fallback;
}

/** True when the lead matches anything on the do-not-contact list. */
export function isSuppressed(...fields) {
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  if (!hay) return false;
  return db().prepare('SELECT pattern FROM suppression').all()
    .some(({ pattern }) => hay.includes(String(pattern).toLowerCase()));
}

/** Messages already sent today, used to enforce the daily cap. */
export function sentToday() {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  return db().prepare("SELECT COUNT(*) AS n FROM messages WHERE status='sent' AND sent_at >= ?")
             .get(since.toISOString()).n;
}

/** Insert a scouted job. Returns 'inserted' or 'duplicate'. Dedupe is on source_id. */
export function upsertJob(job) {
  const d = db();
  const existing = d.prepare('SELECT id FROM jobs WHERE source_id = ?').get(job.source_id);
  if (existing) return { result: 'duplicate', id: existing.id };
  const info = d.prepare(`
    INSERT INTO jobs (source, source_id, company, company_tier, title, url, apply_url, location_raw,
                      employment_type, remote_scope, remote_detail, salary_min, salary_max,
                      salary_currency, salary_period, salary_source, posted_at, content, raw_json,
                      track, discovered_at, updated_at, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new')
  `).run(
    job.source, job.source_id, job.company ?? null, job.company_tier ?? 'unknown', job.title,
    job.url ?? null, job.apply_url ?? null, job.location_raw ?? null,
    job.employment_type ?? 'unknown', job.remote_scope ?? 'unknown', job.remote_detail ?? null,
    job.salary_min ?? null, job.salary_max ?? null, job.salary_currency ?? null,
    job.salary_period ?? null, job.salary_source ?? 'unknown', job.posted_at ?? null,
    job.content ?? null, job.raw ? JSON.stringify(job.raw) : null, job.track ?? null, now(), now()
  );
  return { result: 'inserted', id: Number(info.lastInsertRowid) };
}

/** Record an eligibility/screening verdict. The reason is mandatory: --near-miss is only as
 *  useful as the reasons stored here, and a silent reject is a bug we cannot see. */
export function setJobVerdict(id, { eligibility, reason, layer, status, score = null, track = null, tier = null }) {
  db().prepare(`
    UPDATE jobs SET eligibility=?, eligibility_reason=?, eligibility_layer=?, status=?,
                    score=COALESCE(?, score), track=COALESCE(?, track), tier=COALESCE(?, tier), updated_at=?
    WHERE id=?`).run(eligibility, reason, layer, status, score, track, tier, now(), id);
}

/** Dismiss a job from the dashboard, or bring it back. */
export function setJobHidden(id, hidden = true) {
  db().prepare('UPDATE jobs SET hidden=?, updated_at=? WHERE id=?').run(hidden ? 1 : 0, now(), id);
}

if (process.argv.includes('--init')) {
  db();
  console.log(`Initialized ${DB_PATH}`);
}
