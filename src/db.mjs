// Single source of truth for the whole CEO agent system.
// Uses node:sqlite (built into Node 22+), so the pipeline has zero dependencies.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// One data directory per run, chosen by the environment.
//
// Everything normally points at the owner's real pipeline: the database, the resume fact bank and
// every application packet all live under `data/`. DATA_DIR exists so a throwaway copy can be
// driven by the same code, which is what the public demo build does - it fills a scratch directory
// with an invented candidate and invented jobs and runs the real server against it. That is the
// only way the demo can be trusted to match what the dashboard actually does.
//
// It is also a safety rail. The demo generates packets by calling the real packet builder, and the
// real packet builder writes to the fact bank's directory. Without this, building the demo would
// mean temporarily swapping the owner's own resume out of the way, and an interrupted build would
// leave it swapped. Nothing under `data/` is touched unless DATA_DIR is unset.
export const DATA = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');
const DB_PATH = join(DATA, 'pipeline.db');

// The same idea for config. `config/candidate.json` holds a salary floor, a work-authorisation
// status and an FX table, and the dashboard reports all three - so a demo pointed at the real
// config would publish the owner's pay expectations. CONFIG_DIR lets the demo run against the
// `.example.json` files instead, which is what they are for.
export const CONFIG = process.env.CONFIG_DIR ? resolve(process.env.CONFIG_DIR) : join(ROOT, 'config');

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
  error       TEXT,
  gmail_draft_id TEXT,              -- the draft sitting in the owner's real Gmail
  gmail_thread_id TEXT,             -- set once it is actually sent, so replies can be found
  gmail_url   TEXT,                 -- one click from the dashboard to the draft
  delivery    TEXT                  -- 'claimed' = a button press, 'verified' = seen in Gmail Sent
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
  missing_runs       INTEGER NOT NULL DEFAULT 0,  -- consecutive sweeps absent from its own board
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
-- The overview and the tier chips are the dashboard's front page, and both were grouping over the
-- wide table: grouping by source had no index at all and scanned it whole, and grouping by tier
-- with hidden = 0 found its rows through idx_jobs_hidden and then did a random lookup per row just
-- to read tier. Measured on 5,285 rows: 1,249ms and 1,784ms warm, and the whole front page took 12.9
-- seconds on a cold cache. Grouping needs the grouped column IN the index, not just the filter.
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_hidden_tier  ON jobs(hidden, tier);
CREATE INDEX IF NOT EXISTS idx_jobs_hidden_track ON jobs(hidden, track);
CREATE INDEX IF NOT EXISTS idx_jobs_elig_hidden_track ON jobs(eligibility, hidden, track);
-- The Profile tab reads the top-scoring postings per track to work out what that track's language
-- actually is. Without this it sorted the whole track on an unindexed expression.
CREATE INDEX IF NOT EXISTS idx_jobs_track_score ON jobs(track, score DESC);
-- The Jobs tab asks for its facet menus on every visit. Grouping by remote_scope found its rows
-- through idx_jobs_hidden and then went back to the table for the column, which is the same
-- lookup-into-a-wide-row trap as every other slow query here.
CREATE INDEX IF NOT EXISTS idx_jobs_hidden_scope ON jobs(hidden, remote_scope);
-- The near-miss view needs the REASON for every rejected posting in order to group them, and the
-- title for the samples it shows. idx_jobs_elig_company covers neither, so 5,596 rows each meant a
-- random lookup into a row carrying up to 20KB of job description: 12.5 seconds for a page that
-- displays 25 rows per group. Carrying the two text columns in the index costs about a megabyte.
CREATE INDEX IF NOT EXISTS idx_jobs_nearmiss ON jobs(eligibility, company, id, title, eligibility_reason);

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
  outcome           TEXT,                    -- rejected | interview | offer | ghosted
  outcome_at        TEXT,
  outcome_note      TEXT,                    -- where it came from: an email subject, a portal, you
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
    mkdirSync(DATA, { recursive: true });
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL;');
    // Wait for a lock instead of failing on it.
    //
    // The dashboard server holds the same file, and with no busy timeout a batch write during a
    // dashboard read fails instantly with "database is locked" - which killed a 57-packet rebuild
    // on its second packet. Ten seconds is far longer than any statement here takes.
    _db.exec('PRAGMA busy_timeout = 10000;');
    // On an existing database an index over a newly-added column fails before migrate() can add it,
    // and that takes the whole schema statement down with it. So: create what we can, migrate, then
    // run the schema again now that every column exists.
    try { _db.exec(SCHEMA); } catch { /* expected on an older database; migrate() fixes it */ }
    migrate(_db);
    _db.exec(SCHEMA);
    // Migration for databases created before dedupe_key existed, then the index, in that order.
    const cols = _db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
    if (!cols.includes('dedupe_key')) _db.exec('ALTER TABLE leads ADD COLUMN dedupe_key TEXT');
    // Gmail columns. A button press is a CLAIM that something was sent; only finding it in Gmail
    // Sent is EVIDENCE. Both drafts read 'sent' here while Gmail had never heard of either.
    const mcols = _db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    for (const [col, type] of [['gmail_draft_id','TEXT'],['gmail_thread_id','TEXT'],['gmail_url','TEXT'],['delivery','TEXT']]) {
      if (!mcols.includes(col)) _db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
    }
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
    // How many consecutive full sweeps this posting was absent from its own board. Two means gone.
    ['missing_runs', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, ddl] of added) {
    if (!cols.includes(name)) d.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${ddl}`);
  }

  // What happened after you applied. Applying is the middle of the story, not the end, and until
  // now the database stopped at applied_at - so "I applied to 40 things" could not be turned into
  // "and 31 said no", which is the number that tells you whether the packets are working.
  const appCols = d.prepare('PRAGMA table_info(applications)').all().map((c) => c.name);
  for (const [name, ddl] of [['outcome', 'TEXT'], ['outcome_at', 'TEXT'], ['outcome_note', 'TEXT']]) {
    if (!appCols.includes(name)) d.exec(`ALTER TABLE applications ADD COLUMN ${name} ${ddl}`);
  }

  // Everything that belongs to a person rather than to the world needs an owner.
  //
  // Default 0 is the single-user owner, which is what every row created before accounts existed
  // is. The dashboard reads user_id 0 when it is running on someone's own machine with no login,
  // so those rows stay exactly where they were.
  for (const table of ['applications', 'budget_months', 'envelopes', 'transactions', 'money_goals']) {
    const c = d.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name);
    if (c.length && !c.includes('user_id')) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table}(user_id)`);
    }
  }
}

/**
 * Make sure the files every module reads actually exist.
 *
 * config/candidate.json is gitignored, because it holds a real name, salary expectations and
 * work-authorisation status. So a fresh clone has only the .example.json, and the first command a
 * new user runs dies on ENOENT inside a stack trace. Seeding from the example turns that into a
 * working default they can edit, and `npm run setup` fills in the parts that matter.
 *
 * This runs at import rather than on demand because a dozen modules read these files directly, and
 * one seam everything already passes through beats a dozen guards that can be forgotten.
 */
function ensureConfigs() {
  for (const dir of ['data', 'data/resume', 'data/applications', 'outbox']) {
    try { mkdirSync(join(ROOT, dir), { recursive: true }); } catch { /* already there */ }
  }
  for (const [example, real] of [
    ['config/candidate.example.json', 'config/candidate.json'],
    ['config/money.example.json', 'config/money.json'],
  ]) {
    const target = join(ROOT, real);
    const source = join(ROOT, example);
    if (!existsSync(target) && existsSync(source)) {
      try { copyFileSync(source, target); } catch { /* read-only checkout, not fatal */ }
    }
  }
}
ensureConfigs();

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
/**
 * One date format in the database, whatever the board sent.
 *
 * Boards disagree: Greenhouse sends ISO, Lever sends epoch milliseconds, Himalayas sends epoch
 * seconds as a float in a string - "1789188343.0". Most adapters pass the value straight through,
 * so 117 postings had that string sitting in posted_at where a date belongs. The dashboard printed
 * it verbatim, and sorting by newest compared it as text against "2026-09-12", which is not a
 * comparison that means anything.
 *
 * Normalising in each adapter would fix the boards we have looked at and miss the next one, so it
 * happens here, at the one place every posting passes through.
 */
export function toIsoDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;              // already a date
  if (/^\d{9,13}(\.\d+)?$/.test(s)) {                       // epoch, seconds or milliseconds
    const n = Number(s);
    const ms = n > 1e12 ? n : n * 1000;                      // 1e12 ms is 2001; anything under is seconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);                                     // RFC 2822 and friends
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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
    job.salary_period ?? null, job.salary_source ?? 'unknown', toIsoDate(job.posted_at),
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
/**
 * Full-text search over the postings.
 *
 * A LIKE over `content` takes about a second on 7,000 rows, because each one carries up to 20KB of
 * job description and there is no way to index a leading wildcard. FTS5 ships with node:sqlite, so
 * the index is free; this is an external-content table, meaning it stores only the index and reads
 * the text back out of `jobs` rather than keeping a second copy of every description.
 *
 * Rebuilt rather than trigger-maintained. Triggers would fire on every one of the ~12,000 upserts a
 * run makes, and the rebuild takes a few seconds against a crawl that takes thirty - simpler, and
 * there is no way for the index to drift out of sync with the table.
 */
export function rebuildSearchIndex() {
  const d = db();
  d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
            title, company, location_raw, content,
            content='jobs', content_rowid='id', tokenize='porter unicode61')`);
  d.exec("INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild')");
  return d.prepare('SELECT COUNT(*) n FROM jobs_fts').get().n;
}

/**
 * Turn what a person typed into something FTS5 will accept.
 *
 * Users type `react node` meaning both, and `c++` or `node.js` meaning those literally - all of
 * which are syntax errors or silent mis-parses in FTS5's query language. Every term is quoted and
 * ANDed, and a trailing `*` is kept so "kuber" still finds Kubernetes.
 */
export function ftsQuery(raw) {
  const terms = String(raw || '').match(/[\p{L}\p{N}][\p{L}\p{N}.+#_-]*/gu) || [];
  if (!terms.length) return null;
  return terms.map((t) => {
    const clean = t.replace(/"/g, '');
    // Prefix-match only terms long enough to narrow anything, measured on what the TOKENIZER will
    // see rather than what was typed. "c++" is three characters and one token: unicode61 drops the
    // plus signs, so `"c++"*` becomes `c*` and matched 7,173 of 7,177 postings - every word
    // starting with the letter c. Short terms match whole tokens instead, which is the most the
    // tokenizer can honestly offer them.
    const tokenised = clean.replace(/[^\p{L}\p{N}]/gu, '');
    return tokenised.length >= 3 ? `"${clean}"*` : `"${clean}"`;
  }).join(' AND ');
}

/**
 * Retire postings that have vanished from the board that published them.
 *
 * Only for sources that return a COMPLETE board - Greenhouse, Lever, Ashby. For those, a posting
 * that was there yesterday and is gone today has been taken down, and that is the only reliable
 * closure signal available. Fetching the posting's own page does not work: Railway serves a 1.2KB
 * SPA shell whether the job is live or two years dead, Workable answers 403, and no two boards
 * agree on the wording of "no longer accepting applications".
 *
 * Query-driven sources are excluded on purpose. A Workable search returns eight pages for a phrase;
 * a live job can fall off page eight because thirty newer ones appeared above it. Absence there
 * means nothing at all.
 *
 * Two strikes, not one. Boards have bad mornings, and a single empty response should not retire a
 * company's entire board.
 */
/**
 * Close postings that have vanished from the boards that actually answered.
 *
 * `answeredSlugs` is not optional politeness - it is the whole correctness of this function.
 *
 * It used to take only the source ("greenhouse") and the set of posting ids seen anywhere under
 * it. Greenhouse is forty company boards, and on 2026-11-06 eleven of them threw while the rest
 * answered normally. The aggregate still looked healthy - well over half the held postings were
 * seen - so the guard passed, and every posting at those eleven companies was marked missing. The
 * same eleven boards failed again the next morning and all of it was closed: 152 live jobs at
 * Affirm, 148 at Anthropic, 70 at Coinbase, 60 at Cloudflare, 535 in total, every single one of
 * them still open and still advertised.
 *
 * A board that answered has told us everything about its own company and nothing about anyone
 * else's. A board that threw has told us nothing at all. So the unit of judgement is one company
 * board, and `source_id` carries the slug (`greenhouse:affirm:8197891`) precisely so this can be
 * scoped to the boards that spoke.
 */
export function retireMissing(source, seenSourceIds, answeredSlugs = null) {
  const d = db();
  // Closed rows are IN this query, not filtered out of it. Closing used to be a one-way door: the
  // query said `status != 'closed'`, so a posting wrongly retired could never come back even while
  // its own board went on advertising it. Measured on the 535 that the per-source bug killed: the
  // Affirm board was still listing 84 of them nineteen days later, every crawl saw all 84, and
  // every crawl left them closed. The board is the authority on its own postings in both
  // directions - if it is listing the job, the job is open.
  const rows = d.prepare('SELECT id, source_id, missing_runs, status, eligibility FROM jobs WHERE source = ?').all(source);
  const back = d.prepare('UPDATE jobs SET missing_runs = 0, updated_at = ? WHERE id = ?');
  const miss = d.prepare('UPDATE jobs SET missing_runs = missing_runs + 1, updated_at = ? WHERE id = ?');
  const shut = d.prepare("UPDATE jobs SET status = 'closed', hidden = 1, missing_runs = missing_runs + 1, updated_at = ? WHERE id = ?");
  // `hidden` is also the owner's dismiss flag, so un-hiding has to be narrow. It is safe here
  // because `status = 'closed'` is written by exactly one statement in this codebase - the one
  // above - while a dismissal sets hidden and leaves status alone.
  const open = d.prepare('UPDATE jobs SET status = ?, hidden = 0, missing_runs = 0, updated_at = ? WHERE id = ?');
  const t = now();
  let closed = 0, missing = 0, seen = 0, skipped = 0, reopened = 0;
  for (const r of rows) {
    if (seenSourceIds.has(r.source_id)) {
      if (r.status === 'closed') { open.run(r.eligibility === 'no' ? 'rejected' : 'screened', t, r.id); reopened++; }
      else if (r.missing_runs) back.run(t, r.id);
      seen++;
      continue;
    }
    if (r.status === 'closed') continue;              // already retired and still absent: nothing to do
    // Absence is only evidence if the board that holds this posting actually answered.
    if (answeredSlugs) {
      const slug = String(r.source_id).split(':')[1];
      if (!answeredSlugs.has(slug)) { skipped++; continue; }
    }
    if (r.missing_runs >= 1) { shut.run(t, r.id); closed++; } else { miss.run(t, r.id); missing++; }
  }
  return { seen, missing, closed, skipped, reopened };
}

/**
 * Record what came back. Only the owner ever calls this - there is no inbound path that can.
 *
 * `note` is where the verdict came from, because in three months "rejected" with no provenance is
 * indistinguishable from a mis-click. An email subject line is ideal.
 */
export function setOutcome(jobId, { outcome, note = null }) {
  const ok = ['rejected', 'interview', 'offer', 'ghosted', null];
  if (!ok.includes(outcome)) throw new Error(`outcome must be one of ${ok.filter(Boolean).join(', ')}`);
  const d = db();
  const app = d.prepare('SELECT id FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(Number(jobId));
  if (!app) return null;
  d.prepare('UPDATE applications SET outcome = ?, outcome_at = ?, outcome_note = ? WHERE id = ?')
    .run(outcome, outcome ? now() : null, note, app.id);
  if (outcome) d.prepare("UPDATE jobs SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'applied'")
    .run(now(), Number(jobId));
  return app.id;
}

export function setJobHidden(id, hidden = true) {
  db().prepare('UPDATE jobs SET hidden=?, updated_at=? WHERE id=?').run(hidden ? 1 : 0, now(), id);
}

if (process.argv.includes('--init')) {
  db();
  console.log(`Initialized ${DB_PATH}`);
}
