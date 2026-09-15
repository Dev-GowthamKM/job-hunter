#!/usr/bin/env node
// Resume intake: read a PDF or DOCX, add what it proves to the fact bank, and say plainly what it
// does not prove.
//
// The scoring half matters more than the parsing half. The owner describes himself as a media buyer
// and a Facebook ads manager, and no resume he has evidences either: no campaigns, no platforms, no
// ad spend, no results. `resume-tailor` is forbidden from inventing facts, so a media-buying
// application built from these files would be a software resume with the word ROAS in it. The gap
// interview below is the only thing that fixes that, and it needs him, not a parser.
//
//   node src/jobs/resume.mjs add <file.pdf|file.docx>
//   node src/jobs/resume.mjs score
//   node src/jobs/resume.mjs gaps
//   node src/jobs/resume.mjs answer --track=marketing --q=platforms --a="Meta and Google Ads"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, extname, basename } from 'node:path';
import { ROOT, db, now, logEvent } from '../db.mjs';
import { pdfText } from './pdftext.mjs';
import { coverage } from './ats.mjs';

const MASTER = join(ROOT, 'data', 'resume', 'master.json');
const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

const loadMaster = () => JSON.parse(readFileSync(MASTER, 'utf8'));
const saveMaster = (m) => writeFileSync(MASTER, JSON.stringify(m, null, 2) + '\n');
const loadCand = () => JSON.parse(readFileSync(join(ROOT, 'config', 'candidate.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------

/**
 * Text out of a .docx with no dependencies. A docx is a ZIP; this walks the local file headers,
 * inflates word/document.xml, and strips the tags. Paragraph ends become newlines so the section
 * headings survive, which is what makes the text worth reading at all.
 */
export function docxText(path) {
  const buf = readFileSync(path);
  const SIG = 0x04034b50;
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) !== SIG) continue;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('latin1');
    if (name !== 'word/document.xml') continue;
    const start = i + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + compSize);
    const xml = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    return xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab[^>]*\/>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  throw new Error('No word/document.xml inside that file — is it really a .docx?');
}

export function readResume(path) {
  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return pdfText(path);
  if (ext === '.docx') return docxText(path);
  if (['.txt', '.md'].includes(ext)) return readFileSync(path, 'utf8');
  throw new Error(`Cannot read ${ext} — upload a PDF, DOCX, TXT or MD.`);
}

// ---------------------------------------------------------------------------
// Adding to the fact bank
// ---------------------------------------------------------------------------

/**
 * Facts are MERGED, never replaced. Uploading a second resume adds to what is known rather than
 * overwriting it, because the owner's careers are spread across several documents and no single one
 * of them is complete.
 */
export function addResume(path) {
  const text = readResume(path);
  if (text.length < 120) throw new Error('Got almost no text out of that file. If it is a scanned image, there is nothing to read.');

  const m = loadMaster();
  m.uploads ||= [];
  const name = basename(path);
  const existing = m.uploads.findIndex((u) => u.file === name);
  const entry = {
    file: name,
    addedAt: now(),
    chars: text.length,
    text,
    _note: 'Raw extracted text. resume-tailor reads this alongside the structured facts; it may quote from here but may not embellish it.',
  };
  if (existing >= 0) m.uploads[existing] = entry; else m.uploads.push(entry);

  saveMaster(m);
  logEvent('resume_added', `${name} (${text.length} chars)`);
  return { file: name, chars: text.length, text };
}

// ---------------------------------------------------------------------------
// Scoring: what does the bank actually prove?
// ---------------------------------------------------------------------------

/** The language each track's jobs actually use, taken from real postings already collected. */
function trackLanguage(trackKey, limit = 120) {
  const rows = db().prepare(
    'SELECT content FROM jobs WHERE track = ? AND content IS NOT NULL ORDER BY COALESCE(score,0) DESC LIMIT ?'
  ).all(trackKey, limit);
  return rows.map((r) => r.content).join('\n');
}

/** Everything the fact bank asserts, as one blob. */
export function bankText(m = loadMaster()) {
  const parts = [
    JSON.stringify(m.identity), m.profile?.current,
    ...Object.values(m.skills || {}).flat(),
    ...(m.experience || []).flatMap((e) => [e.title, e.company, ...(e.bullets || [])]),
    ...(m.projects || []).flatMap((p) => [p.name, p.context, ...(p.bullets || [])]),
    ...(m.education || []).map((e) => `${e.credential} ${e.institution}`),
    ...(m.ownerStated || []).map((f) => `${f.question} ${f.answer}`),
    ...(m.uploads || []).map((u) => u.text),
  ];
  return parts.filter((p) => typeof p === 'string').join('\n');
}

export function scoreTracks() {
  const cand = loadCand();
  const m = loadMaster();
  const mine = bankText(m);
  const out = [];

  for (const [key, track] of Object.entries(cand.tracks)) {
    if (track.enabled === false) continue;
    const lang = trackLanguage(key);
    if (!lang) { out.push({ track: key, label: track.label, percent: null, note: 'no jobs collected for this track yet — run a hunt first' }); continue; }
    const c = coverage(lang, mine, 40);
    out.push({
      track: key, label: track.label,
      percent: c.percent, matched: c.matched.slice(0, 20), missing: c.missing.slice(0, 20),
      evidenced: c.percent >= 45,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gap interview
// ---------------------------------------------------------------------------

const QUESTIONS = {
  marketing: [
    ['platforms', 'Which ad platforms have you actually run campaigns on? (Meta/Facebook, Google Ads, TikTok, LinkedIn, Snap…)'],
    ['spend', 'What is the largest monthly ad spend you have personally managed, and in what currency?'],
    ['results', 'Name one campaign and its numbers: ROAS, CPA, CTR, or revenue driven. A real figure beats a good adjective.'],
    ['accounts', 'Whose accounts were they — your own, an employer\'s, a client\'s, or a personal project?'],
    ['tools', 'Which tools do you use: Ads Manager, GA4, Meta Pixel, Triple Whale, Google Tag Manager, spreadsheets?'],
    ['duration', 'Over what period did you do this, and roughly how many hours a week?'],
  ],
  game: [
    ['engines', 'Which engines have you actually built something in — Unity, Unreal, Godot?'],
    ['shipped', 'What have you shipped or published, even a game jam entry or an itch.io page? Links help.'],
    ['scope', 'What did you build yourself versus follow a tutorial for? Be honest; this is the one an interviewer probes.'],
  ],
  ai: [
    ['built', 'Which AI systems have you built end to end, and what did they do for a real user?'],
    ['models', 'Which models and APIs have you worked against — Claude, GPT, open-weights, embeddings?'],
    ['depth', 'Have you done retrieval, evals, fine-tuning, or agent tool-use in anything that ran beyond a demo?'],
  ],
  dev: [
    ['production', 'Has anything you built been used by people who were not you? What, and by how many?'],
    ['stack', 'What is the largest thing you have built, and what was the stack?'],
    ['collab', 'Have you worked in a shared codebase — code review, branches, tickets?'],
  ],
};

export function gaps() {
  const cand = loadCand();
  const m = loadMaster();
  const answered = new Set((m.ownerStated || []).map((f) => `${f.track}:${f.key}`));
  const scored = Object.fromEntries(scoreTracks().map((s) => [s.track, s]));
  const out = [];

  for (const [key, track] of Object.entries(cand.tracks)) {
    if (track.enabled === false) continue;
    const qs = (QUESTIONS[key] || []).filter(([k]) => !answered.has(`${key}:${k}`));
    if (!qs.length) continue;
    out.push({
      track: key, label: track.label,
      coverage: scored[key]?.percent ?? null,
      why: scored[key]?.evidenced
        ? 'Your resume already covers most of this track. These sharpen it.'
        : 'Nothing in your uploaded resumes evidences this track. Without answers here, applications for it cannot be written honestly.',
      questions: qs.map(([k, q]) => ({ key: k, question: q })),
    });
  }
  return out;
}

/** An answer becomes a first-class fact, tagged so nobody mistakes it for something a resume proved. */
export function recordAnswer(track, key, answer) {
  const m = loadMaster();
  m.ownerStated ||= [];
  const q = (QUESTIONS[track] || []).find(([k]) => k === key);
  const idx = m.ownerStated.findIndex((f) => f.track === track && f.key === key);
  const fact = {
    track, key,
    question: q ? q[1] : key,
    answer: String(answer).trim(),
    source: 'owner-stated',
    at: now(),
    _note: 'Stated by the owner, not evidenced by a resume. Usable in an application, and he must be able to defend it in an interview.',
  };
  if (idx >= 0) m.ownerStated[idx] = fact; else m.ownerStated.push(fact);
  saveMaster(m);
  logEvent('resume_answer', `${track}.${key}`);
  return fact;
}

// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith('resume.mjs')) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'add') {
      const r = addResume(process.argv[3]);
      console.log(`Added ${r.file} — ${r.chars} characters of text.`);
      console.log(r.text.slice(0, 600) + (r.text.length > 600 ? '\n…' : ''));
    } else if (cmd === 'score') {
      for (const s of scoreTracks()) {
        console.log(`\n${s.label} (${s.track})`);
        if (s.percent == null) { console.log(`  ${s.note}`); continue; }
        console.log(`  ${s.percent}% of what these jobs ask for appears somewhere in your fact bank`);
        console.log(`  ${s.evidenced ? 'EVIDENCED' : 'NOT EVIDENCED — the gap interview is what fixes this'}`);
        if (s.missing.length) console.log(`  missing: ${s.missing.slice(0, 14).join(', ')}`);
      }
    } else if (cmd === 'gaps') {
      const g = gaps();
      if (!g.length) { console.log('Nothing outstanding.'); }
      for (const t of g) {
        console.log(`\n## ${t.label}  ${t.coverage != null ? `(${t.coverage}% covered)` : ''}`);
        console.log(`${t.why}\n`);
        t.questions.forEach((q) => console.log(`  [${q.key}] ${q.question}`));
      }
      console.log(`\nAnswer with: node src/jobs/resume.mjs answer --track=<track> --q=<key> --a="…"`);
    } else if (cmd === 'answer') {
      const f = recordAnswer(arg('track'), arg('q'), arg('a'));
      console.log(`Recorded (${f.track}.${f.key}): ${f.answer}`);
    } else {
      console.error('usage: node src/jobs/resume.mjs <add|score|gaps|answer> [...]');
      process.exit(1);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
