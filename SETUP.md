# Setting up Job Hunter

Everything runs on your own machine. Nothing is uploaded, no account is needed, and there is no
server to pay for.

## Before you start

You need **Node 22 or newer**. Check with:

```bash
node --version
```

If that prints something lower than `v22`, or "command not found", install it from
[nodejs.org](https://nodejs.org) and reopen your terminal.

You also need **Google Chrome** installed, which is what renders your resume to PDF. Nothing else —
there are no packages to install.

## Three commands

```bash
git clone https://github.com/YOUR_USERNAME/job-hunter.git
cd job-hunter
npm run setup
```

`npm run setup` asks four things — your name, email, where you are based, and your work
authorisation — then which kinds of role to search for. It takes about a minute. All of it stays in
`config/candidate.json` on your machine.

Then:

```bash
npm run hunt     # collect jobs. A few minutes the first time.
npm run web      # open http://127.0.0.1:4321
```

## What you will see

The dashboard sorts everything it found into four groups:

| | |
|---|---|
| **Apply to these** | Open to anyone anywhere, right level, pay in your band |
| **Stretch** | Open to anyone, but above your level or the pay is unclear |
| **Tied to a country** | The right kind of job, but it needs you in a specific place |
| **Not for you** | Not full-time, not your field, or a dealbreaker |

Click any job to see why it landed where it did. Every verdict quotes the sentence from the posting
that caused it, so when the filter is wrong you can see exactly which rule was wrong.

## Add your resume

Job search works without it. Building applications does not — the system will only ever write
things it can trace back to a resume you gave it.

```bash
npm run resume add ~/Downloads/your_resume.pdf
```

PDF or DOCX. Add more than one if you have different versions; the facts merge, they do not replace.

Then, for any job:

```bash
npm run packets
```

Each packet is a folder under `data/applications/` containing a research dossier, a one-page resume
tailored to that posting, a 90-second video script, a slide deck and a recording checklist.

## Things worth knowing

**Nothing is ever submitted for you.** There is no code in this project that sends an application,
uploads a file, or messages anyone. It prepares everything and stops. You apply yourself, on the
company's own site.

**Few results is usually correct.** If you set the reach to "anyone, anywhere" you may see a handful
of matches out of thousands of postings. That is not broken — genuinely location-free, full-time
jobs are rare. Look at the **Tied to a country** group to see what the setting is costing you, and
widen it in `config/candidate.json` if you want.

**It is slower the first time.** The first `npm run hunt` reads around 16,000 postings across 80+
job boards. Later runs skip everything already seen.

## If something goes wrong

| Problem | Fix |
|---|---|
| `command not found: node` | Install Node 22+ from nodejs.org, reopen the terminal |
| `EADDRINUSE` on 4321 | Something else is on that port: `PORT=4322 npm run web` |
| No jobs at all after a hunt | Check the tracks in `config/candidate.json` match what you actually do |
| Resume PDF fails to render | Google Chrome needs to be installed |

## Your data

All of it is local: `data/pipeline.db`, `config/candidate.json`, and your packets under
`data/applications/`. Deleting the folder deletes everything. None of it is gitignored by accident —
those paths are excluded from version control on purpose so you cannot publish them.

---

# Sharing it with friends

You can let friends use your copy over a link instead of each installing it. It costs nothing, but
read the first line of the next section before you do.

## Turn on the gate

```bash
SHARE=1 npm run web
```

`SHARE=1` does two things at once, deliberately: it opens the port beyond localhost **and** it
requires a login on every route. You cannot have one without the other. Without the gate, anyone
with the link gets your resume, your budget, your salary expectations and every application packet
with your phone number on it.

## Put it behind a tunnel

Do not forward the port on your router. Use a tunnel, which gives you an HTTPS address without
opening anything:

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:4321
```

That prints a public `https://…trycloudflare.com` URL. Share that. It lives as long as the command
runs.

## What your friends get

They open the link, click **Create one**, and get their own account: their own profile, their own
resume, their own applications. They search the same pool of collected jobs — that part is shared,
because a job posting is the same fact for everyone — but everything personal is theirs.

They cannot see your resume, your budget, your packets or your client leads. Your `Clients` tab does
not even appear for them.

## What it costs you

Your machine is the server. It has to be awake and running for the link to work, and every search
your friends run uses your connection. For a few people testing, that is nothing. It is not a way to
run something with real users.

## Before you share

- Create your own account first, so your data belongs to it rather than to "no user":
  ```bash
  npm run users create -- --email=you@example.com --name="Your Name"
  npm run users claim  -- --email=you@example.com
  ```
- `npm run users list` shows who has signed up.
- Stopping the `cloudflared` command kills the link immediately.
