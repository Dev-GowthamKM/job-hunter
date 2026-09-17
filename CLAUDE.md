# Job Hunter

Three arms over one SQLite database:

- **`/hunt`** — the job search. Collects postings, screens them, builds application packets. This is
  what the project is named for and where almost all the engineering lives.
- **`/ceo`** — client acquisition. Scouts freelance leads and drafts outreach, behind the same
  approval gate. Documented first below because it is the oldest arm and sets the rules the others
  inherit.
- **`/money`** — monthly budgeting and offer modelling.

## The client arm (`/ceo`)

A personal CEO agent that finds paid work for the owner, delegates to specialized sub-agents, and
routes client conversations through Telegram.

The owner sells three things (see `config/offers.json`): cinematic websites, AI workflow automation,
and custom AI agent builds. The CEO picks the right one per lead.

## The one law

**No message reaches a human being without the owner tapping approve in Telegram.**

Sub-agents write drafts. Drafts sit at `status='draft'`. The only code that moves a row to
`'approved'` is a button callback from the owner's own Telegram chat, and the only code that sends is
`src/telegram/outbox.mjs`, which reads `status='approved'` and nothing else. Never add a send path to
`src/draft.mjs`, never call the Telegram send API from a sub-agent, and never set a message status by
hand in sqlite. If a task seems to need that, it is the wrong task.

## Tools, not SQL

Agents never touch `data/pipeline.db` directly. Read with `src/report.mjs`, write with `src/draft.mjs`.

```bash
node src/report.mjs                    # standing brief
node src/report.mjs --queue=new        # leads at a stage, with full source text
node src/report.mjs --lead=42          # one lead, everything known about it
node src/report.mjs --inbox            # unanswered client messages
node src/scout.mjs                     # collect new leads from every enabled source
node src/draft.mjs qualify --lead=42 --score=78 --offer=agents --notes="..."
node src/draft.mjs research --lead=42 --angle="..."
node src/draft.mjs message --lead=42 --channel=telegram --body-file=outbox/lead-42.md
node src/draft.mjs reply --chat=12345 --body-file=outbox/reply-12345.md
node src/draft.mjs suppress --pattern="acme.com" --reason="asked us not to contact"
```

Lead stages: `new → qualified | rejected → researched → drafted → sent → replied → won | lost`.

## What this system will not do

- No scraping behind a login, and no automation on LinkedIn or Upwork. Both ban it and detect it.
  For those, the owner pastes a job post in and the agents research and draft from that.
- No contacting anyone on the `suppression` table. `src/draft.mjs` refuses, by design.
- No exceeding `dailySendCap` in `config/targets.json`.
- No inventing credentials, case studies, client names, or results. If `data/profile.md` does not
  claim it, the pitch does not claim it. A fabricated case study is the fastest way to lose a deal
  and the owner's reputation.

## Data quality warnings earned the hard way

- **OSM leads are candidates, not facts.** A missing `website` tag means OpenStreetMap does not know
  of a site, not that none exists. The scout probes the obvious domains and records `probedWebsite`,
  but the probe is a filter, not proof. Before any "you have no website" claim reaches a draft, the
  researcher confirms it independently. This was verified: the raw query happily returned Wahaca and
  Breddos, both of which have live sites.
- **HN's freelancer thread has dried up.** Across July, August and September 2026 it carried zero
  `SEEKING FREELANCER` posts, only freelancers advertising. The parser still runs because it costs
  one request, but the volume comes from `Ask HN: Who is hiring?` instead.
- **OSM runs one query per category, and it is slow.** Measured: a single category clause on the
  Bengaluru bbox took 65 seconds on the public mirror, so the six categories cannot share one
  request. A full city takes roughly 3 to 9 minutes and that is normal, not a hang. A category that
  times out is skipped and the rest are kept; the run only fails if every category times out.
- **RemoteOK requires attribution.** Their API terms ask for a dofollow link to remoteok.com wherever
  their listings are shown. OSM data is ODbL and needs attribution if republished.

## Style for anything a client will read

Plain sentences. No em dashes. No "I hope this finds you well", no "I came across your profile", no
flattery, no three-paragraph windup. Lead with the specific thing you noticed about them, say what
you would do, say what it costs, ask one question. Under 120 words for a first message. If the draft
could have been sent to a hundred other people unchanged, it is not finished.

---

# The other two arms

`/ceo` above sells to clients. Two sibling skills cover the rest of the owner's money.

## `/hunt` — full-time remote jobs

Finds full-time, remote-from-anywhere roles at $50k to $150k, researches them, tailors the resume,
builds a Loom package, and stops.

```bash
node src/jobs/hunt.mjs                 # 77 verified boards, ~10k postings, ~20 seconds
node src/jobs/report.mjs               # what is worth his time
node src/jobs/report.mjs --near-miss   # what the filter rejected, and why
node src/jobs/score.mjs
node src/jobs/verdict.mjs --job=42 --eligible=no --reason="<quote the posting>"
node src/jobs/apply.mjs init|render|review --job=42
```

Job stages: `new → screened → shortlisted → researched → tailored → packaged → ready → applied`.

### The one law, again

**Nothing is submitted without the owner approving that specific job.** `apply.mjs` has no send path
and never will. `approve` is in the deny list in `.claude/settings.json` so no agent can run it. Do
not add form filling, do not add an upload, and never create an account on a job portal or type a
credential anywhere. If a task seems to need that, it is the wrong task.

### The resume may not be embellished

Every claim traces to `data/resume/master.json`, which carries a `source` per fact and a
`doNotClaim` list. The tailorer selects, reorders and rewords. It does not add. Canonical alone runs
four one-hour technical interviews including a dedicated Linux one, so a keyword that cannot be
defended costs more than the one left out.

## `/money` — the monthly budget

```bash
node src/money/report.mjs              # this month, burn rate, savings rate
node src/money/report.mjs --goals
node src/money/ledger.mjs plan  --month=2026-09 --amount=60000
node src/money/ledger.mjs spend --envelope=food --amount=450 --note="groceries"
node src/money/offer.mjs --usd=90000   # what an offer means after Indian tax
```

**No investment advice, and nothing that moves money.** No fund, no stock, no asset, not even as a
hypothetical. There is no brokerage integration, no transfer code and no bank credential in the
repo, and that is deliberate. The `invest` envelope is a holding bucket that records what he decided
and never opines on it. Projections are arithmetic on the return rate he set in `config/money.json`,
and every projection prints that rate.

# Data quality warnings earned the hard way, job side

- **A verdict without a quote is worthless.** Every accept and reject in `eligibility.mjs` records
  the sentence that caused it, and `--near-miss` groups them by reason. This is not decoration. It
  is the only reason the filter can be trusted, and reading it caught four rules that were silently
  wrong before anything shipped.
- **"Worldwide" in body prose means nothing.** "Our services help businesses worldwide" and "we are
  a globally distributed team" are marketing, not eligibility. Treating them as signal marked 70
  US-only and UK-only roles as eligible. Location fields are trusted; body prose is not, except for
  a narrow list of explicit hiring statements in `BODY_ACCEPT`.
- **A perks line cannot widen a stated location.** Sardine's "Work from anywhere: Remote-first
  Culture" was overriding a location field that said North America. When the board names a place,
  the board wins.
- **Salary is not the first money range in the document.** Postings list equity, signing bonuses and
  wellness stipends, often before base pay. Affirm's "New hire equity: $16,000-$24,000" made a $190k
  role look like a $24k one. `parseSalary` scores every candidate range by the words around it.
- **"Contract of Employment" is a permanent job.** It is European employment-law boilerplate, not
  contractor work. Rejecting on a bare `/contract/` was throwing away good full-time roles, and
  fixing it is what unlocked Canonical's entire board.
- **Silence about location is not permission.** A posting that says nothing is far more often a
  domestic role that forgot to mention it. Under `global-only` an unclear verdict is not researched.
- **`global-only` is expensive and he should see the bill.** Of ~10,000 postings it yields roughly
  18, and essentially all of them are Canonical, because very few large employers genuinely hire
  home-based worldwide. When the near-miss report shows good jobs lost only to geography, say so and
  offer `global-plus-india`. It is a one-line change in `config/candidate.json` and it is his call.
- **His salary ceiling filters out good jobs.** Roughly 350 rejections were roles paying *above*
  $150k. If he would take more, `compensation.max` needs raising.
- **`config/companies.json` is the real asset.** Quality comes from which boards are polled, not
  from keywords. Lever slugs are unguessable and Greenhouse 404s silently, so every slug in there
  was verified live. Re-check with `--verify-companies` when a source goes quiet.

# The dashboard

`npm run web`, then http://127.0.0.1:4321. Everything `/hunt` and `/money` do from a terminal, done
from a browser: run the hunt with live streaming output, browse jobs, open packets, read near
misses, log spending, model an offer.

**It is an interface to the same rules, not a way around them.** There is no route in
`src/web/server.mjs` that submits an application, uploads a file, or sends a message, and there must
never be one. `/api/apply/<id>/approve` records the owner's decision and demands an explicit confirm
token; a button click there is the owner acting, exactly as typing the command is. An agent driving
that endpoint would be the failure mode this whole system is shaped to prevent.

Bound to 127.0.0.1 with no auth, because there is no listener anyone else can reach. Do not add a
`0.0.0.0` bind or a tunnel without adding authentication first.

`npm run service schedule` adds a second agent that runs `src/jobs/daily.mjs` (hunt, then score) on
a `StartCalendarInterval`. It is deliberately not `KeepAlive` — that flag on a task which is meant
to exit is an infinite loop against other people's job boards — and deliberately not `RunAtLoad`,
which would fire a two-hour crawl every time someone logs in. **It must never apply to
anything.** A scheduled task is the worst possible place to weaken the approval gate.

`launchctl bootout` returns before the job is actually gone. Bootstrapping straight after it races
the unload, fails, and leaves nothing registered — no process, no agent, and an install that
reported success. `src/service.mjs` polls until the old job is really gone, and afterwards trusts
the registration rather than the exit code.

`npm run service install` keeps it up: a launchd **user agent**, not a daemon, because this process
reads the owner's resume and budget out of their home directory and should run as them. Verified by
`kill -9`, not by reading the plist — launchd brought it back with a new PID.

The health probe in `src/service.mjs` uses `node:http`, not `fetch`, and must stay that way. `npm
run` injects twenty `npm_config_*` variables, and undici reads proxy settings out of the
environment; the probe reported "not answering" while the server was serving on that exact port.
A health check for a socket on this machine should not be reroutable by an environment variable.

# Layer 2 runs itself now

`src/jobs/adjudicate.mjs` reads the postings the deterministic filter could not decide and rules on
them, quoting the posting exactly as `verdict.mjs` demands. `daily.mjs` calls it after hunt and
score, capped at 40 postings a run, and every run prints its own token count and dollar cost.

Three things about it that are deliberate:

- **No API key is not an error.** It prints why and exits 0, because the nightly collection must not
  fail over an optional step. A run where *every* call fails does exit 1 — that is a wrong key or a
  dead model name, not flakiness.
- **The key is read from `.env`, never the shell.** launchd inherits no shell environment, so a key
  in `.zshrc` would mean layer 2 silently skipped itself every night.
- **It records a verdict and nothing else.** No apply, no send, no approve. A model reading job
  descriptions overnight is useful; a model deciding to submit an application is the failure this
  system exists to prevent, and a scheduled task is the worst possible place to allow it.

# An empty panel is a lie

`show()` called each tab's async loader without awaiting it and without a `.catch`, so any throw
inside one rejected into nothing: no error, no console line, just a tab that stayed blank. The Jobs
list also painted nothing at all while its request was in flight. Together those read as "the
system lost all your data", which is the worst thing a dashboard can imply and was never true.

Loaders now report failures through `toast()`, and the jobs list says `Loading…` and then either
the rows, the empty state, or the error with a retry.

# Performance, earned the hard way

`jobs.content` carries up to 20KB per row. Sorting on an unindexed column therefore makes SQLite do
a random lookup into a very wide row, and it is catastrophic rather than merely slow: `ORDER BY
company` over 2,282 rows measured **9,800ms** against **35ms** unsorted. The near-miss endpoint took
16 seconds and looked like an empty page. There is now a covering index on
`(eligibility, company, id)` and the grouping sorts in JS. Sort small result sets in JS; index
anything the database must sort.

# Style for anything a hiring manager will read

Same rules as client writing above, plus: name the specific thing about the company that proves he
read past the careers page, and state the gaps plainly. The owner is early-career, and the fact bank
is the only source of what he can claim. A packet that wins a screen and loses the first call is
worse than no application.

# v2 — tracks, and what changed

The job side was rebuilt around **role tracks** after the owner pointed out that every "eligible" job
was a Canonical Linux role he had no interest in.

- **`src/jobs/tracks.mjs`** resolves a job into `dev`, `ai`, `marketing` or `game` before anything
  else. The track decides the salary floor, the seniority rule and which resume facts apply. Longest
  title match wins, so "media analyst" beats "analyst".
- **`roleRelevant()` used to discard off-list jobs before storing them**, which is why v1 held zero
  media-buying postings. Anything not in a track is still dropped, but the tracks now cover both of
  his careers.
- **Exclusion is company-level as well as title-level.** Canonical is in `excludeCompanies` because
  patching titles one at a time — "kernel", then "k8s", then "container images" — was losing a race
  it could not win against a board that is Linux systems work end to end.
- **The country list is exhaustive on purpose.** A hand-written region list knew Canada and Poland
  but not Armenia, Serbia or Georgia, so 21 junior media-buying roles pinned to those countries fell
  through as "location unstated" and were never judged.

## Measured, so nobody has to re-guess it

- `global-only` over 12,192 postings: **1** eligible job. `global-plus-india`: **22**. That is why
  the mode is set to the latter.
- Marketing coverage: **360** postings from Workable alone, against **0** in v1.
- Track coverage is uneven: the resumes evidence the engineering tracks well and the marketing track
  poorly. A track the owner claims but cannot evidence is a packet that fails at the first call.
  `node src/jobs/resume.mjs gaps` reports it; only the owner can close it.

## The bookmarklet

`src/jobs/autofill.mjs` generates a one-line bookmarklet that fills an application form in the
owner's own browser, on his own click. **It must never contain a click on a submit control.**

Two traps in it, both already hit:
- The generated script is minified by stripping newlines, so a single `//` comment inside it comments
  out everything after. Comments are stripped first, deliberately.
- Question-shaped labels are matched against the answer sheet *before* the field map. Without that,
  "Are you authorised to work in this country?" matched the country field and was filled with "India".

# Tiers replaced the eligible/rejected verdict

A binary verdict showed 23 jobs and pushed 4,000 behind a "near misses" page nobody had a reason to
open. `tierOf()` in `src/jobs/eligibility.mjs` keeps the same judgement in front of the owner:

| Tier | Meaning |
|---|---|
| `match` | Work from anywhere, right level, pay in the track's band. |
| `stretch` | Work from anywhere, but above his level or the pay is unknown. His call. |
| `regional` | Right kind of job, needs him in a specific country. |
| `no` | Not full-time, not his field, or a dealbreaker. |

Current, under strict `global-only`: **4 match, 48 stretch, 4,032 regional, 497 no.** That is not a
broken filter — genuinely worldwide, full-time, junior-level roles are rare. Say so rather than
loosening the filter behind his back.

# Under-collection is the usual cause of "no jobs"

Workable reports `totalSize` per query and serves 20 at a time. The first version took page one:
20 of 2,999 AI-engineer postings, 0.7% of what existed, and then the work-from-anywhere filter was
blamed for finding nothing. Sources paginate deeply now — Workable 8 pages per track title,
Himalayas 40 cursor pages. A deep run is ~16,000 postings.

**Before concluding a filter is too strict, check what the sources actually returned.**

**A full run takes about two hours, not fourteen minutes.** Measured 2026-09-17: 7,448 seconds over
16,614 postings, 451 of them new. The old "14 minutes" figure in these notes was wrong and was
being repeated to the owner by `npm run service schedule`. It is CPU-bound while it runs - regex
screening and per-row SQLite writes - not blocked on the network.

# Boards disagree about what a date is

Greenhouse sends ISO, Lever sends epoch milliseconds, Himalayas sends epoch **seconds as a float in
a string** - `"1789188343.0"`. Most adapters passed the value straight through, so 117 postings had
that string sitting in `posted_at`. The dashboard printed it verbatim and "sort by newest" compared
it as text against `"2026-09-12"`, which put the two newest eligible jobs at the bottom of the list.

`toIsoDate()` in `src/db.mjs` normalises in `upsertJob`, not in each adapter - fixing the adapters
fixes the boards already looked at and misses the next one.

# A global word only means everywhere when it is the only thing the field says

Elastic writes `Canada | Distributed, Global` and `United States | Distributed, Global`, meaning a
role in that country on a globally distributed team. The global-token-first check read the
`Global`, stopped, and put **44 country-locked roles into match and stretch** — the tiers that say
"apply to these". Same lesson as the perks line that overrode a stated location: when the board
names a place, the board wins, even when it names a place and says "global" in the same breath.

The check is `namesAPlaceBesidesGlobal()`, and it **tokenises rather than strips**. Stripping words
one at a time meant "Fully remote, worldwide" left `Fully`, "100% remote, worldwide" left `100%`,
and "anywhere in the world" left `in` — each read as a place name, and each fix revealed the next.
Letters only, and anything not in `NON_PLACE` is somewhere.

# A timezone list is numbers, and the numbers are the meaning

Boards append `timezones: -11, -10, … 12.75` to the location. That list is every offset on earth
and *confirms* worldwide — but `timezones` is a word, so reading the field as text saw a place name
and rejected eight genuinely global roles. Caught by re-screening real data after the fix above,
not by reasoning.

Read as numbers it is better than harmless. **45 postings in the current database are pinned to a
narrow band** and used to read as "Worldwide": 18 to UTC+1 alone, 12 to the Americas. Six sit at
UTC+5.5, which is where the owner is, and those are now labelled as including India rather than
lost. `readTimezones()` strips the clause before any text check and rules on the span.

# Geography: never match against a list of place names

Two versions of this were wrong. A region list knew Canada and Poland but not Armenia or Serbia. A
country list then dropped every city, so Toronto and Tokyo read as "no location stated". The rule
that works: a location field exists to say *where*, so anything in it that is not a generic remote
word ("remote", "distributed", "home based") is naming somewhere, and somewhere is not everywhere.
Global tokens are checked first, because "Remote - Anywhere" is both generic and global.

# One page is enforced, not requested

`renderOnePage()` in `src/jobs/render.mjs` renders, counts `/Type /Page` objects in the PDF, and
trims the least important line until it fits — trailing project bullets, then trailing experience
bullets, then whole trailing projects. An agent cannot know how tall its prose renders, so asking it
for one page in a prompt does not work. It reports what it cut.

# Packets are built in bulk

`node src/jobs/apply.mjs batch --tier=all` builds a folder, the posting, a track-aware seeded resume
and a rendered one-page PDF for every match and stretch. Research and the Loom script still need an
agent per job. Building them one at a time is why exactly one of 4,582 jobs had a packet.

# Research and Loom are generated for every packet, not a chosen few

`src/jobs/research.mjs` and `src/jobs/loom.mjs` run inside `apply.mjs init`, so `batch` produces a
complete packet per job: posting, dossier, one-page resume, 90-second script, slide deck, checklist.
Before this, 1 of 58 packets had research — the agents were the only path and there was never time
to run them 58 times.

The dossiers are a **mechanical pass over the posting**: what the top of the requirements list asks
for, which named technologies the fact bank evidences, which it does not, and the pay reality. They
say so at the top. A `job-researcher` run on a job the owner decides to pursue overwrites the file
with funding, news and a confirmed remote policy — the things a parser cannot know.

**Skill matching is on whole tokens.** Plain substring matching claimed `java` because he knows
`javascript`, and `go` because the letters appear in `django`. Both are the kind of false claim that
dies in the first technical screen. `evidences()` in `research.mjs` compares tokens, and `techIn()`
drops `node` when `node.js` already matched so nothing is reported as both present and missing.

# The resume is in colour, and the rail order is the owner's

Navy header and rail, amber accent, white main column. Rail order is **Profile → Expertise →
Education → Languages → Contact**: a recruiter scans for what he does, not for his phone number.
Colour is background and rules only; every character is real selectable text, and DOM order is still
header → experience → rail so an ATS reads the work history first.

# Slides are built to survive video compression

`templates/slides.html` is the deck; `loom.mjs` replaces only the `#deck` JSON block. Fraunces for
headings, Inter for body, JetBrains Mono for the one big number. Company logos come from
`logo.clearbit.com/<domain>`, with the domain taken from the apply URL **after** the ATS hosts are
filtered out — otherwise every deck gets the Greenhouse logo. A logo that fails to load falls back
to a gradient lettermark, so someone else's CDN can never break a slide the owner is about to
present.

# A rendered packet is awaiting_approval, not building

`apply.mjs render` used to leave the row at `'building'`, so the dashboard reported 0 packets waiting
while 57 sat finished. Anything with a rendered resume and no `approved_at` is waiting on the owner.
