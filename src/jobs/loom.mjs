#!/usr/bin/env node
// The Loom package for one job: a 90-second script, a slide deck to screen-share, and a checklist.
//
// Built from the research dossier and the fact bank, so every packet gets one rather than only the
// handful an agent has time to write by hand. A `loom-producer` run can overwrite any of these
// files with something sharper for a job the owner has decided to pursue.
//
// It writes words for the owner to say. It does not record, and there is no upload path here.
//
//   node src/jobs/loom.mjs --job=42
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, db } from '../db.mjs';
import { buildResearch } from './research.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

/** A company's own domain, taken from the apply URL, so a logo can be fetched for the deck. */
function companyDomain(job) {
  const skip = /greenhouse|lever|ashby|workable|himalayas|remoteok|jobicy|arbeitnow|remotive|workingnomads|myworkdayjobs|smartrecruiters|breezy|recruitee|teamtailor|bamboohr/i;
  for (const u of [job.apply_url, job.url]) {
    if (!u) continue;
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      if (!skip.test(host)) return host;
    } catch { /* not a URL we can read */ }
  }
  return null;
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

export function buildLoom(job, master) {
  const r = buildResearch(job, master);
  const company = job.company || 'your team';
  const domain = companyDomain(job);
  const logo = domain ? `https://logo.clearbit.com/${domain}` : null;

  const strongest = (master.projects || [])
    .find((p) => /agent money maker|multi-agent/i.test(p.name)) || (master.projects || [])[0];
  const projectName = strongest?.name || 'the system I built';

  const overlap = r.has.slice(0, 3);
  const gapYears = r.years?.[1] || null;

  // ~90 seconds is about 210 spoken words. Every line below is counted, not estimated.
  const script = {
    open: `Hi, I'm Gowtham. I'm applying for the ${job.title} role at ${company}.`
      + ` I applied here rather than everywhere, and I want to be specific about why — but first,`
      + ` thirty seconds on what I've actually built.`,

    built: `I built a system that polls dozens of job boards and screens around sixteen thousand`
      + ` postings a run, in Node, with no dependencies. The interesting part isn't the scraping.`
      + ` Every accept and every reject records the sentence from the posting that caused it, so the`
      + ` filter can be audited instead of trusted. Reading that output found four rules in my own`
      + ` code that were quietly wrong. One was reading equity grants as base salary.`,

    fit: overlap.length
      ? `On your posting: you named ${overlap.join(', ')}, and those are things I've actually used,`
        + ` not things I've read about.`
      : `I'll be straight about the overlap: your stack isn't one I've worked in yet. What I can`
        + ` point at is having built something substantial on my own initiative.`,

    gap: gapYears
      ? `And the gap: you ask for ${gapYears} years. I have about one. I'd rather say that now than`
        + ` have you find it in the third interview.`
      : `And the honest part: I graduated in 2025, so I have about a year behind me. What I have`
        + ` instead is a habit of building things nobody asked me to build.`,

    ask: `If that's worth twenty minutes, I'd like to talk. My resume's attached. Thanks for watching.`,
  };

  const total = Object.values(script).reduce((a, s) => a + words(s), 0);

  const slides = [
    { brand: { name: company, logo },
      kicker: `Application · ${job.title}`,
      h1: 'Gowtham K M',
      lead: `${master.identity?.headline || 'AI Engineer'} · ${master.identity?.location || ''}` },

    { kicker: 'What I built',
      big: '16,000',
      bigSub: 'job postings screened per run, across dozens of boards, in Node with zero dependencies — full-time, salary band, and whether I am actually eligible.' },

    { kicker: 'The part that matters',
      h2: 'Every accept and reject records the sentence that caused it.',
      list: [
        'So the filter can be **audited**, not trusted',
        'Reading that output found **four rules in my own code** that were quietly wrong',
        'One read **equity grants as base salary** — a $190k role looked like $24k',
        'It is also how I found this job',
      ] },

    { kicker: 'Honest fit',
      h2: 'What I bring, and what I don’t.',
      columns: [
        { head: 'I have',
          items: [
            ...(overlap.length ? [`Their stack: **${overlap.join(', ')}**`] : []),
            'Projects built beyond any curriculum',
            'A year of client work **entirely in English**',
            'B.E. Artificial Intelligence & Data Science, 2025',
          ].slice(0, 4) },
        { head: 'I don’t, yet',
          items: [
            ...(r.missing.slice(0, 3).map((m) => m)),
            ...(gapYears ? [`The **${gapYears} years** asked for — I have one`] : []),
          ].slice(0, 4) },
      ] },

    { brand: { name: company, logo },
      kicker: 'The ask',
      h1: 'Twenty minutes.',
      lead: 'Not the strongest candidate on paper. A strong one on evidence of building things nobody asked for.' },
  ];

  return { script, slides, total, overlap, missing: r.missing, gapYears, company, logo, projectName };
}

function scriptMd(job, L) {
  const s = L.script;
  return `# ${L.company} — ${job.title} · 90 seconds

**${L.total} words. Read at a normal pace this lands around 1:${String(Math.round(L.total / 3.5) % 60).padStart(2, '0')}.**
Read it twice, then say it in your own words. A script that sounds read is worse than one that wanders.

---

## 0:00–0:14 · Who, and why them
> *[Slide 1 — on camera, no screen share yet]*

"${s.open}"

---

## 0:14–0:48 · The one thing I built
> *[Share screen — Slides 2 and 3]*

"${s.built}"

---

## 0:48–1:12 · The fit, and the gap
> *[Slide 4 — the two-column one]*

"${s.fit}

${s.gap}"

---

## 1:12–1:28 · The ask
> *[Slide 5 — back to camera]*

"${s.ask}"

---

## Before you record

- **Do not soften the gap line.** Saying it and moving straight on is stronger than hedging.
  Hedging reads as hiding.
${L.missing.length ? `- **Do not claim ${L.missing.slice(0, 4).join(', ')}.** They are on the posting and not in your fact bank, and the technical screen will open there.\n` : ''}\
- **Slide 1 needs one sentence you wrote yourself** about ${L.company}, from their product page, not
  their careers page. This script cannot supply it, and without it the Loom reads as a template.
- One retake maximum. A slightly imperfect Loom that sounds human beats a fourth take that sounds
  like an advert.
`;
}

function checklistMd(job, L) {
  return `# Recording checklist — ${L.company}, ${job.title}

## Before you hit record

- [ ] Open \`loom/slides.html\`. Press **F** for full screen. Test **←** and **→** once.
- [ ] \`script.md\` open on your phone or a second screen, never the screen you are sharing.
- [ ] Notifications off. A banner mid-recording means a retake.
- [ ] Camera at eye level, light in front of you, not behind.
- [ ] Loom set to **cam + screen** so your face stays in the corner.

## Shape

| Time | Slide | You are |
|---|---|---|
| 0:00–0:14 | 1 | On camera |
| 0:14–0:48 | 2 → 3 | Sharing, what you built |
| 0:48–1:12 | 4 | Sharing, honest fit |
| 1:12–1:28 | 5 | Back to camera |

## Loom settings

- **Title:** \`Gowtham K M — ${job.title} application\`
- **Description:** \`90 seconds on why ${L.company}, what I've built, and where I fall short.\`
- Link set to **anyone with the link can view**. A viewer hitting a login wall closes the tab.

## The message you send with it

> Hi — I've applied for the ${job.title} role.
>
> Rather than another cover letter, here's 90 seconds on why ${L.company} specifically, the system I
> built that screens sixteen thousand job postings a run, and honestly where I fall short:
> [loom link]
>
> Resume attached. Happy to go straight to a call whenever suits.

${!job.salary_min ? `## Ask early\n\nThis posting publishes no salary. Ask the range in your first reply rather than after four stages.\n` : ''}`;
}

export function loomJob(id, { quiet = false } = {}) {
  const job = db().prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  if (!job) throw new Error(`No job ${id}`);
  const master = JSON.parse(readFileSync(join(ROOT, 'data', 'resume', 'master.json'), 'utf8'));

  const L = buildLoom(job, master);
  const dir = join(ROOT, 'data', 'applications', String(job.id), 'loom');
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'script.md'), scriptMd(job, L));
  writeFileSync(join(dir, 'checklist.md'), checklistMd(job, L));

  const tpl = readFileSync(join(ROOT, 'templates', 'slides.html'), 'utf8');
  const deck = JSON.stringify({ who: `Gowtham K M — ${job.title}`, slides: L.slides }, null, 2);
  const html = tpl.replace(
    /<script type="application\/json" id="deck">[\s\S]*?<\/script>/,
    () => `<script type="application/json" id="deck">\n${deck}\n</script>`,
  ).replace('<title>Loom slides</title>', `<title>Gowtham K M — ${L.company}</title>`);
  writeFileSync(join(dir, 'slides.html'), html);

  if (!quiet) {
    console.log(`loom → ${dir}`);
    console.log(`  script.md     ${L.total} words (~90s)`);
    console.log(`  slides.html   ${L.slides.length} slides${L.logo ? ', with company logo' : ''}`);
    console.log(`  checklist.md`);
  }
  return { dir, words: L.total, slides: L.slides.length };
}

if (process.argv[1] && process.argv[1].endsWith('loom.mjs')) {
  const id = arg('job');
  if (!id) { console.error('usage: node src/jobs/loom.mjs --job=<id>'); process.exit(1); }
  loomJob(id);
}
