#!/usr/bin/env node
// Fills a scratch data directory with an invented candidate and invented jobs.
//
// This exists so the public demo can be driven by the real code. Every number the demo page shows
// is produced by the same server, the same screening rules and the same packet builder that run
// against the owner's own pipeline - the only difference is which directory they were pointed at.
// A hand-written mock would drift the first time a rule changed; this cannot.
//
// NOTHING HERE IS REAL AND NOTHING HERE IS THE OWNER'S. The candidate is fictional, the companies
// are invented, and the page says so. The owner's resume carries a phone number, an email and a
// home address, and a demo is a permanent public page - so the demo gets its own person.
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DATA, CONFIG, db, now, logEvent } from '../../db.mjs';

if (!process.env.DATA_DIR || !process.env.CONFIG_DIR) {
  console.error('Refusing to run without DATA_DIR and CONFIG_DIR set. This writes a fact bank and\n' +
                'a database, and unset means it would write the real ones.');
  process.exit(1);
}

// ── The fictional candidate ────────────────────────────────────────────────────────────────────
// Shaped exactly like a real fact bank: every claim carries a `source`, and `doNotClaim` is the
// list the tailorer is forbidden from crossing. That structure is the point of the demo.
const MASTER = {
  _comment: 'DEMO DATA. Alex Rivera does not exist. This file exists so the public demo has a '
    + 'candidate to tailor for without publishing a real person\'s contact details.',
  identity: {
    name: 'Alex Rivera',
    headline: 'Full-stack engineer · AI systems',
    email: 'alex@example.com',
    phone: '+1 555 0100',
    linkedin: 'linkedin.com/in/example',
    location: 'Lisbon, Portugal',
    languages: ['English (native)', 'Portuguese (conversational)'],
    source: 'demo',
  },
  profile: {
    current: 'Full-stack engineer with two years building production web applications, moving '
      + 'toward applied AI work. Comfortable owning a feature from schema to deploy.',
    source: 'demo',
  },
  skills: {
    engineering: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Docker', 'REST APIs'],
    ai: ['LLM prompting', 'Retrieval-augmented generation', 'OpenAI API', 'Vector search'],
    familiar: ['Python', 'Redis', 'GitHub Actions'],
    source: 'demo',
  },
  experience: [
    { company: 'Meridian Software', title: 'Software Engineer', start: '2024-03', end: 'present',
      source: 'demo',
      bullets: [
        'Built the customer-facing billing dashboard in React and Node, used by 4,000 accounts.',
        'Cut median API response time from 800ms to 180ms by adding covering indexes and removing N+1 queries.',
        'Took the on-call rotation for three services and wrote the runbooks the team still uses.',
      ] },
    { company: 'Hollow Pine Studio', title: 'Junior Developer', start: '2023-01', end: '2024-02',
      source: 'demo',
      bullets: [
        'Shipped twelve client marketing sites on a shared component library.',
        'Automated the deploy pipeline, taking a release from forty minutes of manual steps to one command.',
      ] },
  ],
  projects: [
    { name: 'Ledgerline', context: 'Side project', source: 'demo',
      bullets: ['A double-entry bookkeeping API with zero runtime dependencies.',
                'Handles 12,000 transactions a second on a laptop.'] },
    { name: 'Rulecheck', context: 'Open source', source: 'demo',
      bullets: ['A linter for RAG pipelines that flags prompts leaking retrieved context into system messages.'] },
  ],
  education: [
    { institution: 'University of Coimbra', credential: 'BSc Computer Science',
      start: '2019', end: '2023', grade: '16/20', location: 'Coimbra, Portugal', source: 'demo' },
  ],
  certifications: [],
  // The list the tailorer may never cross. A demo that did not show this would be hiding the
  // single most important rule in the system.
  doNotClaim: [
    'Kubernetes in production — has only run it locally',
    'Team leadership — has never managed anyone',
    'Machine learning research — has trained no models from scratch',
    'Paid media buying — no campaign experience of any kind',
  ],
  uploads: [],
};

// ── The invented postings ──────────────────────────────────────────────────────────────────────
// Spread across every tier and every track on purpose, so the demo shows the filter disagreeing
// with itself rather than a page of green ticks. The rejections carry the sentence that caused
// them, because that is the part of this system worth showing.
const J = (o) => o;
const JOBS = [
  // — match: worldwide, right level, pay in band
  J({ company: 'Northwind Labs', title: 'Full Stack Engineer', track: 'dev', tier: 'match',
      loc: 'Remote — Worldwide', scope: 'worldwide', min: 85000, max: 115000,
      tierco: 'funded-startup', score: 91, elig: 'yes',
      why: 'Posting says "We hire anywhere in the world and have no headquarters."',
      body: `We are a fully distributed team of 40 building developer tooling.

We hire anywhere in the world and have no headquarters. Contract of Employment is issued through our
employer of record in your country.

What you will do
- Own features end to end in TypeScript, React and Node.js
- Design PostgreSQL schemas and the APIs on top of them
- Share the on-call rotation with six other engineers

Requirements
- 2+ years shipping production web applications
- Strong JavaScript and TypeScript
- Comfortable with SQL and query performance
- Docker, and enough CI to keep a pipeline green

Nice to have
- Experience with retrieval-augmented generation
- Open source contributions

Compensation: $85,000 - $115,000 depending on location and experience.
New hire equity: $10,000 - $20,000 vesting over four years.` }),
  J({ company: 'Tessellate', title: 'AI Engineer', track: 'ai', tier: 'match',
      loc: 'Remote (Anywhere)', scope: 'worldwide', min: 95000, max: 130000,
      tierco: 'funded-startup', score: 88, elig: 'yes',
      why: 'Posting says "This role is open to candidates anywhere in the world."',
      body: `Tessellate builds retrieval infrastructure for regulated industries.

This role is open to candidates anywhere in the world. We have teammates in 14 countries.

You will
- Build and evaluate RAG pipelines against real customer corpora
- Own prompt design and the evaluation harness that keeps it honest
- Work directly with the two founders on what ships next

We are looking for
- 2+ years of software engineering, any stack
- Hands-on work with an LLM API in production, not just a demo
- Python or TypeScript
- Vector search: pgvector, Qdrant, or similar

Base salary $95,000 - $130,000. Wellness stipend $1,200 per year.` }),
  J({ company: 'Broadfin', title: 'Frontend Engineer', track: 'dev', tier: 'match',
      loc: 'Fully remote, worldwide', scope: 'worldwide', min: 78000, max: 96000,
      tierco: 'brand', score: 84, elig: 'yes',
      why: 'Posting says "we are remote-first and hire globally, with no location requirement."',
      body: `Broadfin is a payments company serving 90,000 small businesses.

We are remote-first and hire globally, with no location requirement.

The work
- React and TypeScript across our merchant dashboard
- Design system ownership alongside two designers
- Accessibility to WCAG 2.2 AA, which we treat as a requirement and not a nice to have

You should have
- 2+ years of frontend work in a component framework
- Real CSS skill, not just utility classes
- An eye for performance budgets

$78,000 - $96,000 plus equity.` }),

  // — stretch: worldwide, but too senior or pay unknown
  J({ company: 'Halcyon Systems', title: 'Senior Full Stack Engineer', track: 'dev', tier: 'stretch',
      loc: 'Remote — Global', scope: 'worldwide', min: 140000, max: 175000,
      tierco: 'brand', score: 72, elig: 'unclear',
      why: 'Wants 6+ years; the fact bank evidences two. Pay also tops out above the band.',
      body: `Senior engineer, global remote.

Requirements
- 6+ years building and operating production systems
- Experience leading a team of three or more engineers
- Deep knowledge of distributed systems

$140,000 - $175,000.` }),
  J({ company: 'Orbit Study', title: 'AI Automation Engineer', track: 'ai', tier: 'stretch',
      loc: 'Remote, anywhere', scope: 'worldwide', min: null, max: null,
      tierco: 'funded-startup', score: 69, elig: 'unclear',
      why: 'Work from anywhere and the right level, but the posting publishes no salary.',
      body: `We automate back-office work for universities. Remote, anywhere.

You will build agent workflows that read documents and file them correctly, and the evaluation that
proves they did. 2+ years engineering experience. Compensation discussed on the first call.` }),
  J({ company: 'Palework', title: 'Game Developer (Unity)', track: 'game', tier: 'stretch',
      loc: 'Remote worldwide', scope: 'worldwide', min: null, max: null,
      tierco: 'watch', score: 58, elig: 'unclear',
      why: 'Genuinely worldwide, but the fact bank has no shipped game to point at.',
      body: `Small studio, four people, one shipped title. Remote worldwide.

Unity, C#, mobile. Show us something you have shipped. Salary not published.` }),

  // — regional: right job, wrong geography. The biggest bucket, as it is in reality.
  J({ company: 'Kestrel Health', title: 'Full Stack Engineer', track: 'dev', tier: 'regional',
      loc: 'Remote (United States)', scope: 'country', min: 110000, max: 140000,
      tierco: 'funded-startup', score: 0, elig: 'no',
      why: 'Location field says "Remote (United States)". A stated place is a restriction.',
      body: 'Remote within the United States only. Must be authorised to work in the US without sponsorship.' }),
  J({ company: 'Steinweg Digital', title: 'Performance Marketing Manager', track: 'marketing', tier: 'regional',
      loc: 'Remote — Germany', scope: 'country', min: 55000, max: 70000,
      tierco: 'watch', score: 0, elig: 'no',
      why: 'Location field says "Remote — Germany".',
      body: 'Remote from anywhere in Germany. Meta and Google Ads, €400k monthly spend across twelve accounts.' }),
  J({ company: 'Auckland Bright', title: 'Media Buyer', track: 'marketing', tier: 'regional',
      loc: 'Remote (New Zealand)', scope: 'country', min: null, max: null,
      tierco: 'watch', score: 0, elig: 'no',
      why: 'Location field says "Remote (New Zealand)".',
      body: 'NZ-based only. Paid social buying for e-commerce brands.' }),
  J({ company: 'Vantage Tokyo', title: 'Backend Engineer', track: 'dev', tier: 'regional',
      loc: 'Tokyo (hybrid)', scope: 'onsite', min: null, max: null,
      tierco: 'brand', score: 0, elig: 'no',
      why: 'Location field says "Tokyo (hybrid)" — two days a week in the office.',
      body: 'Hybrid, two days a week in our Shibuya office.' }),
  J({ company: 'Cresta Iberia', title: 'AI Engineer', track: 'ai', tier: 'regional',
      loc: 'Remote — EU timezones', scope: 'region', min: 70000, max: 90000,
      tierco: 'funded-startup', score: 0, elig: 'no',
      why: 'Location field says "Remote — EU timezones", which is a region and not everywhere.',
      body: 'Remote within EU timezones. CET plus or minus two hours.' }),

  // — no: not full-time, not the field, or a dealbreaker
  J({ company: 'Pellham Group', title: 'Full Stack Developer (6 month contract)', track: 'dev', tier: 'no',
      loc: 'Remote worldwide', scope: 'worldwide', min: null, max: null,
      tierco: 'unknown', score: 0, elig: 'no',
      why: 'Posting says "six month fixed-term contract, no extension planned". Not full-time.',
      body: 'Six month fixed-term contract, no extension planned. Day rate negotiable.' }),
  J({ company: 'Lumen Interactive', title: 'Unpaid Game Design Intern', track: 'game', tier: 'no',
      loc: 'Remote', scope: 'worldwide', min: null, max: null,
      tierco: 'unknown', score: 0, elig: 'no',
      why: 'Posting says "unpaid internship, 12 weeks, for course credit".',
      body: 'Unpaid internship, 12 weeks, for course credit.' }),
  J({ company: 'Farrow Media', title: 'Senior Media Buyer', track: 'marketing', tier: 'no',
      loc: 'Remote worldwide', scope: 'worldwide', min: 90000, max: 120000,
      tierco: 'watch', score: 0, elig: 'no',
      why: 'Wants 5+ years of paid media. The fact bank has none, and doNotClaim says so explicitly.',
      body: '5+ years managing paid media budgets above $1M annually. Meta, TikTok, Google.' }),
];

// ── Write it ───────────────────────────────────────────────────────────────────────────────────
mkdirSync(join(DATA, 'resume'), { recursive: true });
writeFileSync(join(DATA, 'resume', 'master.json'), JSON.stringify(MASTER, null, 2) + '\n');

// The example configs are the shipped ones, so the demo runs on exactly what a fresh clone gets.
mkdirSync(CONFIG, { recursive: true });
copyFileSync(join(ROOT, 'config', 'candidate.example.json'), join(CONFIG, 'candidate.json'));
copyFileSync(join(ROOT, 'config', 'money.example.json'), join(CONFIG, 'money.json'));
// The demo candidate lives in Lisbon, so the budget is in euros. The example config ships in
// rupees because the owner is in India; the demo should not inherit that.
const mcfg = JSON.parse(readFileSync(join(CONFIG, 'money.json'), 'utf8'));
mcfg.currency = 'EUR'; mcfg.symbol = '\u20ac';
writeFileSync(join(CONFIG, 'money.json'), JSON.stringify(mcfg, null, 2) + '\n');
for (const f of ['companies.json', 'offers.json', 'targets.json']) {
  copyFileSync(join(ROOT, 'config', f), join(CONFIG, f));
}
// The demo shows every tier, so it has to run in the mode that produces them.
const cand = JSON.parse(readFileSync(join(CONFIG, 'candidate.json'), 'utf8'));
cand.eligibility.mode = 'global-only';
cand.identity = { ...(cand.identity || {}), name: MASTER.identity.name, email: MASTER.identity.email,
  phone: MASTER.identity.phone, location: MASTER.identity.location };
writeFileSync(join(CONFIG, 'candidate.json'), JSON.stringify(cand, null, 2) + '\n');

const D = db();
const t = now();
const ins = D.prepare(`INSERT INTO jobs
  (id, source, source_id, company, company_tier, title, url, apply_url, location_raw,
   employment_type, remote_scope, remote_detail, salary_min, salary_max, salary_currency,
   salary_period, salary_source, posted_at, content, discovered_at, updated_at, status, score,
   eligibility, eligibility_reason, eligibility_layer, track, tier, hidden)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);

const days = (n) => new Date(Date.now() - n * 864e5).toISOString();
JOBS.forEach((j, i) => {
  const slug = j.company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  ins.run(i + 1, 'demo', `demo-${slug}-${i}`, j.company, j.tierco, j.title,
    `https://example.com/jobs/${slug}`, `https://example.com/jobs/${slug}/apply`, j.loc,
    'FullTime', j.scope, j.loc, j.min, j.max, j.min ? 'USD' : null, j.min ? 'year' : null,
    j.min ? 'parsed' : 'unknown', days(i + 1), j.body, t, t,
    j.elig === 'yes' ? 'screened' : 'rejected', j.score,
    j.elig, j.why, 'rules', j.track, j.tier);
});

// A hunt run, so the overview has a "last run" to report.
logEvent('hunt_run', { found: JOBS.length, sources: 1, kept: JOBS.length });

// A budget month, so the money tab is not empty.
D.prepare(`INSERT INTO budget_months (month, allocated, currency, opened_at, user_id)
           VALUES (?,?,?,?,0)`).run('2026-09', 3000, 'EUR', t);
const env = D.prepare(`INSERT INTO envelopes (month, name, kind, planned, user_id) VALUES (?,?,?,?,0)`);
const spend = D.prepare(`INSERT INTO transactions (month, envelope, amount, note, at, user_id)
                         VALUES (?,?,?,?,?,0)`);
for (const [name, planned] of [['rent', 1100], ['food', 450], ['transport', 120],
                               ['tools', 90], ['savings', 900], ['invest', 340]])
  env.run('2026-09', name, ['savings', 'invest'].includes(name) ? 'save' : 'spend', planned);
for (const [e, a, n] of [['rent', 1100, 'September rent'], ['food', 214, 'groceries'],
                         ['food', 38, 'coffee, week 2'], ['tools', 20, 'domain renewal'],
                         ['transport', 61, 'metro pass']]) spend.run('2026-09', e, a, n, t);

console.log(`Seeded ${JOBS.length} demo jobs into ${DATA}`);
