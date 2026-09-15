# Job Hunter

A multi-agent system that aggregates job boards, screens postings against structured eligibility
rules, and generates complete application packets — research dossier, tailored one-page resume,
90-second presentation script and slide deck — for every job that survives the filter.

**Zero runtime dependencies.** Node 22+, `node:sqlite`, and the copy of Chrome already on the
machine. No npm install.

```bash
npm run web        # dashboard at http://127.0.0.1:4321
npm run hunt       # ~16,000 postings across 80+ boards
npm run packets    # build a full application packet for every match
```

---

## What it does

```
sources → eligibility (rules) → eligibility (agent) → scoring → research
       → resume tailoring → Loom package → human approval gate
```

| Stage | What happens |
|---|---|
| **Collect** | 77 curated company boards (Greenhouse / Lever / Ashby) plus cross-company search on Workable, Himalayas, RemoteOK, Jobicy, Arbeitnow, Remotive, Working Nomads. |
| **Screen** | Deterministic rules decide full-time, salary band, seniority and geography. Every verdict records the sentence from the posting that caused it. |
| **Adjudicate** | Only postings the rules could not decide reach an LLM agent. |
| **Packet** | Research dossier, one-page tailored resume rendered to PDF, 90-second script, slide deck, recording checklist. |
| **Gate** | Nothing is submitted. Ever. The system prepares; a human applies. |

## The parts worth reading

**`src/jobs/eligibility.mjs` — an auditable filter.**
Every accept and every reject stores the quote that caused it, grouped by reason in the UI. This is
not decoration; it is the only reason the filter can be trusted. Reading that output during
development caught four rules that were silently wrong:

- `worldwide` was matching marketing copy — "our services help businesses worldwide" — and marking
  70 US-only roles as globally open.
- A perks line ("Work from anywhere: Remote-first Culture") was overriding a location field that
  said *North America*.
- The salary parser took the first money range in the document. `New hire equity: $16,000-$24,000`
  made a $190k role score as $24k. It now scores every candidate range by the words around it.
- `contract` was matching *"Contract of Employment"* — European boilerplate for a **permanent** job —
  and discarding good full-time roles.

**`src/jobs/pdftext.mjs` — PDF text extraction in ~120 lines, no dependencies.**
macOS ships no PDF reader, and `brew install poppler` is a poor first step for a resume parser. This
inflates the content streams and reads the text-showing operators, handling the two things a naive
version gets wrong: UTF-16BE strings, and subset fonts whose glyph codes are offset from the real
characters. Without the second, a resume decodes to `* H Q H U D W L Y H` instead of `Generative`.

**`src/jobs/render.mjs` — one page, enforced.**
An LLM cannot know how tall its prose renders, so asking it for a one-page resume in a prompt does
not work. The renderer counts `/Type /Page` objects in the output PDF and trims the least important
line — trailing project bullets, then experience bullets, then whole projects — until it fits, and
reports what it cut.

**`src/web/` — a dashboard with no build step.**
One HTTP server and one HTML file. Pipeline runs stream back over a POST as server-sent events.

## Geography is the hard part

Matching location against a list of place names does not work, and cannot be made to work. A region
list knew Canada and Poland but not Armenia or Serbia. A country list dropped every city, so
*Toronto* and *Tokyo* read as "no location stated". The rule that holds:

> A location field exists to say **where**. Anything in it that is not a generic remote word is
> naming somewhere, and somewhere is not everywhere.

Global tokens are checked first, because "Remote – Anywhere" is both generic and global.

## Tiers, not a verdict

An eligible/rejected binary showed 23 jobs and buried 4,000 behind a page nobody had a reason to
open. The same judgement, kept visible:

| Tier | Meaning |
|---|---|
| `match` | Work from anywhere, right level, pay in band |
| `stretch` | Work from anywhere, but above your level or pay unclear |
| `regional` | Right role, needs you in a specific country |
| `no` | Not full-time, not your field, or a dealbreaker |

## The approval gate

There is **no code path in this repository that submits an application, uploads a file, or sends a
message.** `approve` records a decision and nothing else. It is in the deny list in
`.claude/settings.json` so no agent can invoke it.

The form-filling bookmarklet (`src/jobs/autofill.mjs`) runs in your own browser, on your own click,
and never contains a click on a submit control.

## Setup

```bash
npm run setup    # four questions, about a minute
npm run hunt     # collect
npm run web      # http://127.0.0.1:4321
```

Node 22+ and Google Chrome (which renders the PDFs). Nothing to install. Full walkthrough in
[SETUP.md](SETUP.md).

`config/candidate.json` drives everything — the tracks you search, the salary bands per track, the
seniority rules and the eligibility mode. `data/resume/master.json` is the fact bank: the resume
tailorer may select, reorder and reword from it, and may never add to it.

## Two sibling arms

The same database and the same approval gate carry two smaller systems:

- **`/ceo`** — client acquisition. Scouts freelance leads from HN, RemoteOK, WeWorkRemotely and
  OpenStreetMap, qualifies them, and drafts outreach. Nothing sends without a human tap.
- **`/money`** — monthly envelope budgeting, burn rate, and a calculator for what a job offer is
  actually worth after tax. It moves no money and gives no investment advice, by design: there is no
  brokerage integration and no bank credential anywhere in the repo.

## Licence

MIT.
