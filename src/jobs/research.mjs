#!/usr/bin/env node
// A research dossier for one job, built from the posting itself and the owner's fact bank.
//
// Every packet needs research before it is worth sending, and there are 50+ packets. Running an
// agent per job would be the ideal and is not affordable, so this does the mechanical 80% for
// every job: what the posting actually asks for, which of those the owner can evidence, which he
// cannot, and the specific lines worth saying. A `job-researcher` agent can then deepen the few
// he decides to pursue, and its output overwrites this file.
//
//   node src/jobs/research.mjs --job=42
//   node src/jobs/research.mjs --job=42 --print
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, db } from '../db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

const REQ_HEADING = /^\s*(what we (?:are )?look(?:ing)? for|requirements?|qualifications?|the role entails|responsibilities|what you.{0,12}ll (?:do|bring|need)|must[- ]have|nice[- ]to[- ]have|skills?|about you|who you are|your profile|we.{0,4}d love)/i;
const STOP_HEADING = /^\s*(about (the )?(company|us)|what we offer|benefits|perks|compensation|equal opportunit|our culture|how to apply|why join)/i;

/** Lines that read as list items, which is how postings state what they actually want. */
function bulletLines(text = '') {
  return text.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 18 && l.length < 320)
    .filter((l) => !/^https?:/i.test(l));
}

/** The requirements block, if the posting has recognisable headings. */
function requirementBlock(text = '') {
  const lines = text.split('\n');
  let inReq = false;
  const out = [];
  for (const line of lines) {
    if (REQ_HEADING.test(line)) { inReq = true; continue; }
    if (STOP_HEADING.test(line)) { inReq = false; continue; }
    if (inReq && line.trim()) out.push(line.trim());
  }
  return out.filter((l) => l.length > 18 && l.length < 320);
}

/** Technologies and platforms the posting names, checked against a known vocabulary. */
const TECH = ['javascript', 'typescript', 'react', 'vue', 'angular', 'svelte', 'node.js', 'node', 'python',
  'django', 'flask', 'fastapi', 'go', 'golang', 'rust', 'java', 'kotlin', 'swift', 'php', 'laravel',
  'ruby', 'rails', 'c++', 'c#', '.net', 'sql', 'mysql', 'postgresql', 'postgres', 'mongodb', 'redis',
  'graphql', 'rest api', 'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'git',
  'llm', 'openai', 'anthropic', 'claude', 'gpt', 'rag', 'langchain', 'llamaindex', 'vector database',
  'pinecone', 'embeddings', 'prompt engineering', 'fine-tuning', 'pytorch', 'tensorflow', 'hugging face',
  'meta ads', 'facebook ads', 'google ads', 'tiktok ads', 'google analytics', 'ga4', 'looker',
  'tableau', 'power bi', 'hubspot', 'salesforce', 'klaviyo', 'shopify', 'unity', 'unreal', 'figma'];

function techIn(text = '') {
  const t = text.toLowerCase();
  const found = TECH.filter((k) => new RegExp(`(^|[^a-z])${k.replace(/[.+#*]/g, '\\$&')}([^a-z]|$)`, 'i').test(t));
  // "node.js" and "node" both match the same sentence; keep the specific one so the dossier does
  // not report the same technology as both evidenced and missing.
  return found.filter((k) => !found.some((other) => other !== k && other.startsWith(k) && other.length > k.length));
}

/** Every skill the owner can actually evidence, flattened out of the fact bank. */
function ownerSkills(master) {
  // master.skills carries a `source` string alongside the real lists; it is provenance, not a skill.
  const lists = Object.entries(master.skills || {})
    .filter(([k, v]) => k !== 'source' && Array.isArray(v)).map(([, v]) => v);
  return [...new Set(lists.flat().map((s) => String(s).toLowerCase()))];
}

/**
 * Does the owner evidence this technology?
 *
 * Plain substring matching says yes to "java" because he knows "javascript", and yes to "go"
 * because the letters appear in "django". Both are the kind of false claim that dies in the first
 * technical screen, so matching is on whole tokens.
 */
const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean);

function evidences(tech, ownerList) {
  const want = tokens(tech).join(' ');
  return ownerList.some((skill) => {
    const have = tokens(skill).join(' ');
    if (have === want) return true;
    // Multi-word technologies match when the whole phrase is present, e.g. "meta ads" in
    // "meta / facebook ads". Single words must match a whole token, never a fragment.
    return want.includes(' ')
      ? have.includes(want)
      : tokens(skill).includes(want);
  });
}

const YEARS = /(\d+)\s*\+?\s*(?:-\s*\d+\s*)?years?(?:'| of)? (?:of )?(?:professional |relevant |industry |commercial |software )?experience/i;

export function buildResearch(job, master) {
  const content = job.content || '';
  const reqs = requirementBlock(content);
  const bullets = reqs.length ? reqs : bulletLines(content);

  const tech = techIn(content);
  const mine = ownerSkills(master);
  const has = tech.filter((t) => evidences(t, mine));
  const missing = tech.filter((t) => !has.includes(t));

  const years = YEARS.exec(content);
  const firstPara = content.split(/\n\s*\n/).map((p) => p.trim())
    .find((p) => p.length > 120 && !/^(about|we are looking)/i.test(p)) || content.slice(0, 400);

  // The top of a requirements list is the job; the tail is a wish list.
  const topThree = bullets.slice(0, 3);

  const pay = job.salary_min
    ? `${job.salary_currency || 'USD'} ${job.salary_min.toLocaleString()}–${(job.salary_max || job.salary_min).toLocaleString()} per ${job.salary_period || 'year'} (${job.salary_source})`
    : 'Not published. Ask before the process gets long.';

  return { content, reqs, bullets, tech, has, missing, years, firstPara, topThree, pay };
}

export function renderResearch(job, r, master) {
  const L = [];
  const p = (s = '') => L.push(s);

  p(`# ${job.company || 'Unknown company'} — ${job.title}`);
  p('');
  p(`Job ${job.id} · ${job.url}`);
  p(`Generated from the posting on ${new Date().toISOString().slice(0, 10)}. Mechanical pass — a`);
  p(`\`job-researcher\` run will overwrite this with funding, news and a confirmed remote policy.`);
  p('');

  p('## What the posting says they do');
  p('');
  p(r.firstPara.replace(/\s+/g, ' ').slice(0, 700));
  p('');

  p('## Remote policy');
  p('');
  p(`- **Location field:** ${job.location_raw || '(none stated)'}`);
  p(`- **Verdict:** ${job.eligibility} — ${job.eligibility_reason}`);
  p(`- **Tier:** ${job.tier}`);
  if (job.tier === 'regional') {
    p(`- This one needs you in a specific place. Worth applying only if you would move, or if they`);
    p(`  will consider an Employer-of-Record arrangement. Ask in the first message rather than last.`);
  }
  p('');

  p('## What they actually want');
  p('');
  if (r.topThree.length) {
    p('The first items in a requirements list are the job. The rest is a wish list.');
    p('');
    r.topThree.forEach((b, i) => p(`${i + 1}. ${b.replace(/\s+/g, ' ').slice(0, 240)}`));
  } else {
    p('_The posting has no structured requirements section. Read `job.txt` in full before applying._');
  }
  p('');
  if (r.years) p(`**Experience asked for:** ${r.years[1]} years. You have about one.`);
  p('');

  p('## Technology named in the posting');
  p('');
  p(`- **You can evidence:** ${r.has.length ? r.has.join(', ') : '_nothing on their list, from the fact bank_'}`);
  p(`- **You cannot:** ${r.missing.length ? r.missing.join(', ') : '_nothing missing_'}`);
  p('');
  if (r.missing.length) {
    p('Do not claim anything in the second list. It is what the technical interview will open with.');
    p('');
  }

  p('## Pay');
  p('');
  p(`- ${r.pay}`);
  p('');

  p('## Three things worth saying');
  p('');
  const company = job.company || 'them';
  p(`1. Something specific about **${company}** from their own site — not the careers page. This`);
  p(`   dossier cannot supply it; two minutes on their product page can. Without it the application`);
  p(`   reads as a template.`);
  if (r.has.length) {
    p(`2. The overlap is real: they named **${r.has.slice(0, 3).join(', ')}**, and you have used it.`);
    p(`   Say where, on what, and what broke.`);
  } else {
    p(`2. There is no technology overlap to lead with. Lead with what you built instead — the`);
    p(`   multi-agent job system is self-directed evidence, which is rarer than a matching stack.`);
  }
  if (r.years) {
    p(`3. Name the gap out loud: they ask for ${r.years[1]} years, you have one. Saying it plainly and`);
    p(`   then showing what you built anyway beats hoping nobody checks.`);
  } else {
    p(`3. Name what you are still learning. A graduate who knows the edge of their knowledge`);
    p(`   interviews better than one who does not.`);
  }
  p('');

  p('## Before you send');
  p('');
  p(`- [ ] Read \`job.txt\` in full. This dossier is a summary, not a substitute.`);
  p(`- [ ] Find one concrete fact about ${company} and put it in the Loom's first sentence.`);
  p(`- [ ] Check the resume claims nothing from the "cannot evidence" list above.`);
  if (!job.salary_min) p(`- [ ] Ask the pay range early. Their process may be five stages long.`);

  return L.join('\n') + '\n';
}

export function researchJob(id, { quiet = false } = {}) {
  const job = db().prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  if (!job) throw new Error(`No job ${id}`);
  const master = JSON.parse(readFileSync(join(DATA, 'resume', 'master.json'), 'utf8'));

  const r = buildResearch(job, master);
  const md = renderResearch(job, r, master);

  const dir = join(DATA, 'applications', String(job.id));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'research.md');
  writeFileSync(path, md);

  if (!quiet) console.log(md);
  return { path, has: r.has, missing: r.missing, topThree: r.topThree, years: r.years?.[1] || null };
}

if (process.argv[1] && process.argv[1].endsWith('research.mjs')) {
  const id = arg('job');
  if (!id) { console.error('usage: node src/jobs/research.mjs --job=<id>'); process.exit(1); }
  const out = researchJob(id, { quiet: !process.argv.includes('--print') });
  if (!process.argv.includes('--print')) console.log(`research → ${out.path}`);
}
