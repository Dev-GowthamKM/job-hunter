#!/usr/bin/env node
// Bring in a job from somewhere this pipeline cannot reach.
//
// LinkedIn, Indeed, Naukri, Upwork and Fiverr all block automated access - measured: Indeed and
// Upwork return 403, Naukri needs private headers, LinkedIn is a login-walled app. Rather than
// pretend otherwise, this takes a URL or a block of pasted text and puts it through exactly the same
// screening, scoring and packeting as a job the hunt found itself. Anything you can see, the agent
// can work on.
//
//   node src/jobs/ingest.mjs --url=https://…
//   node src/jobs/ingest.mjs --file=/path/to/pasted.txt --company="Acme" --title="Media Buyer"
//   pbpaste | node src/jobs/ingest.mjs --stdin --title="Media Buyer" --company="Acme"
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, upsertJob, setJobVerdict, logEvent } from '../db.mjs';
import { fetchWithRetry, stripHtml } from '../sources/_util.mjs';
import { screen, roleRelevant } from './eligibility.mjs';
import { scoreJob } from './score.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);

/** Sites that will not serve a job page to a script. Worth saying so rather than failing vaguely. */
const WALLED = /linkedin\.com|indeed\.|naukri\.com|upwork\.com|fiverr\.com|glassdoor\./i;

const readStdin = () => new Promise((r) => { let s = ''; process.stdin.on('data', (c) => { s += c; }); process.stdin.on('end', () => r(s)); });

/**
 * Most modern job pages are JS-rendered shells: fetching job-boards.greenhouse.io returns HTML with
 * no title, no h1 and no JSON-LD, so scraping it yields the site name and nothing else. Every major
 * ATS publishes the same posting over a plain API, so a recognised URL goes there instead.
 */
const ATS_ROUTES = [
  {
    name: 'greenhouse',
    re: /(?:job-boards|boards)\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i,
    api: (slug, id) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`,
    map: (j) => ({ title: j.title, company: j.company_name, content: stripHtml(stripHtml(j.content || '')), location: j.location?.name }),
  },
  {
    name: 'lever',
    re: /jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{16,})/i,
    api: (slug, id) => `https://api.lever.co/v0/postings/${slug}/${id}`,
    map: (j) => ({ title: j.text, company: null, content: stripHtml(j.descriptionPlain || j.description || ''), location: j.categories?.location }),
  },
  {
    name: 'ashby',
    re: /jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{16,})/i,
    api: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    map: (body, id) => {
      const j = (body.jobs || []).find((x) => x.id === id);
      return j && { title: j.title, company: null, content: j.descriptionPlain || '', location: j.location };
    },
  },
];

async function fromAts(url) {
  for (const route of ATS_ROUTES) {
    const m = route.re.exec(url);
    if (!m) continue;
    const [, slug, id] = m;
    try {
      const body = await fetchWithRetry(route.api(slug, id), { timeout: 25000 }).then((r) => r.json());
      const mapped = route.map(body, id);
      if (mapped?.title) return { ...mapped, company: mapped.company || slug, url, via: route.name };
    } catch { /* fall through to HTML */ }
  }
  return null;
}

/** Meta tags and JSON-LD are how most job pages describe themselves, and both beat guessing. */
function fromHtml(html, url) {
  const meta = (prop) => {
    const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html)
      || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i').exec(html);
    return m ? m[1] : null;
  };

  let title = meta('og:title') || (/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? null);
  let company = meta('og:site_name');
  let content = null;

  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const posting = [data, ...(data['@graph'] || [])].find((d) => d && d['@type'] === 'JobPosting');
      if (posting) {
        title = posting.title || title;
        company = posting.hiringOrganization?.name || company;
        content = stripHtml(posting.description || '');
        break;
      }
    } catch { /* a malformed block is not a reason to give up on the page */ }
  }

  if (!content) {
    const body = /<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i.exec(html);
    content = stripHtml(body ? body[1] : html);
  }
  return { title: (title || '').replace(/\s*[|\-–]\s*(LinkedIn|Indeed|Glassdoor).*$/i, '').trim(), company, content, url };
}

export async function ingest({ url, text, title, company }) {
  let job;

  if (text) {
    // Pasted text: the first non-empty line is nearly always the role.
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    job = { title: title || lines[0] || 'Pasted job', company: company || null, content: text, url: url || null };
  } else if (url) {
    if (WALLED.test(url)) {
      const host = new URL(url).hostname.replace(/^www\./, '');
      throw new Error(
        `${host} blocks automated access and its terms forbid scraping, so I cannot fetch that page.\n` +
        `Open it in your browser, select the job description, copy it, and paste it in instead — ` +
        `it goes through exactly the same pipeline.`
      );
    }
    job = await fromAts(url);
    if (!job) {
      const html = await fetchWithRetry(url, { timeout: 25000 }).then((r) => r.text());
      job = fromHtml(html, url);
    }
    if (title) job.title = title;
    if (company) job.company = company;
  } else {
    throw new Error('Give me a --url, a --file, or --stdin.');
  }

  if (!job.content || job.content.length < 200) {
    throw new Error(
      'Got too little text out of that page to judge it — it is probably rendered by JavaScript.\n' +
      'Open it, select the job description, copy it, and paste that instead.'
    );
  }

  const cand = JSON.parse(readFileSync(join(ROOT, 'config', 'candidate.json'), 'utf8'));
  const record = {
    source: 'manual',
    source_id: `manual:${url || title}:${Date.now()}`,
    company: job.company || null,
    company_tier: 'watch',
    title: job.title,
    url: url || null,
    apply_url: url || null,
    location_raw: job.location || null,
    employment_type: 'unknown',
    remote_scope: 'unknown',
    content: job.content.slice(0, 20000),
    salary_source: 'unknown',
    posted_at: new Date().toISOString(),
    raw: { ingestedFrom: url || 'pasted text' },
  };

  const track = roleRelevant(record, cand);
  const verdict = screen(record, cand, track);
  const sal = verdict.salary;

  const { result, id } = upsertJob({
    ...record,
    track: verdict.track,
    salary_min: sal?.min ?? null, salary_max: sal?.max ?? null,
    salary_currency: sal?.currency ?? null, salary_period: sal?.period ?? null,
    salary_source: sal?.source ?? 'unknown',
  });

  // A job the owner went and found himself has already passed his own filter, so it is never thrown
  // away on a rule — a bad verdict is recorded and shown, not acted on by deleting the row.
  const status = verdict.eligibility === 'no' ? 'screened' : 'screened';
  setJobVerdict(id, { eligibility: verdict.eligibility, reason: verdict.reason, layer: verdict.layer, status, track: verdict.track });

  const stored = { ...record, id, track: verdict.track, salary_min: sal?.min ?? null, salary_max: sal?.max ?? null, salary_currency: sal?.currency, salary_period: sal?.period, company_tier: 'watch' };
  const { score } = scoreJob(stored, cand);
  setJobVerdict(id, { eligibility: verdict.eligibility, reason: verdict.reason, layer: verdict.layer, status, score, track: verdict.track });

  logEvent('job_ingested', `${id} ${job.title}`);
  return { id, duplicate: result === 'duplicate', title: job.title, company: job.company, track: verdict.track, eligibility: verdict.eligibility, reason: verdict.reason, score };
}

if (process.argv[1] && process.argv[1].endsWith('ingest.mjs')) {
  const file = arg('file');
  const text = flag('stdin') ? await readStdin() : file ? readFileSync(file, 'utf8') : null;
  try {
    const r = await ingest({ url: arg('url'), text, title: arg('title'), company: arg('company') });
    console.log(`[${r.id}] ${r.company || '?'} — ${r.title}`);
    console.log(`  track ${r.track || 'none'} · score ${r.score} · ${r.eligibility.toUpperCase()}`);
    console.log(`  ${r.reason}`);
    if (r.eligibility === 'no') console.log(`\n  Kept anyway, because you found it yourself. Review it in the dashboard.`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
