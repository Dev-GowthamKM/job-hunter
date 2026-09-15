#!/usr/bin/env node
// Pipeline state as markdown. This is how the CEO agent reads the business without touching sqlite.
//
//   node src/report.mjs                 the standing brief
//   node src/report.mjs --queue=new     leads waiting on a stage, full detail
//   node src/report.mjs --lead=42       everything about one lead
//   node src/report.mjs --inbox         unanswered client messages
import { db } from './db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const d = db();

function brief() {
  const byStatus = d.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status ORDER BY n DESC').all();
  const bySource = d.prepare('SELECT source, COUNT(*) n FROM leads GROUP BY source ORDER BY n DESC').all();
  const msgs = d.prepare('SELECT status, COUNT(*) n FROM messages GROUP BY status').all();
  const inbox = d.prepare("SELECT COUNT(*) n FROM messages WHERE direction='in' AND status='received'").get().n;
  const convos = d.prepare("SELECT COUNT(*) n FROM conversations WHERE state != 'closed'").get().n;

  console.log('# Pipeline\n');
  console.log('## Leads by stage');
  if (!byStatus.length) console.log('_empty — run `npm run scout`_');
  byStatus.forEach((r) => console.log(`- **${r.status}**: ${r.n}`));

  console.log('\n## Leads by source');
  bySource.forEach((r) => console.log(`- ${r.source}: ${r.n}`));

  console.log('\n## Messages');
  if (!msgs.length) console.log('- none yet');
  msgs.forEach((r) => console.log(`- ${r.status}: ${r.n}`));
  console.log(`- **unanswered client messages: ${inbox}**`);
  console.log(`- open conversations: ${convos}`);

  const top = d.prepare(`
    SELECT id, source, score, offer, substr(title,1,72) t FROM leads
    WHERE status IN ('new','qualified','researched') ORDER BY COALESCE(score,-1) DESC, id DESC LIMIT 12`).all();
  console.log('\n## Next up');
  top.forEach((r) => console.log(`- [${r.id}] ${r.score ?? '--'} | ${r.source} | ${r.offer ?? '?'} | ${r.t}`));

  const events = d.prepare('SELECT at, kind, substr(detail,1,90) detail FROM events ORDER BY id DESC LIMIT 5').all();
  console.log('\n## Recent activity');
  if (!events.length) console.log('- nothing logged yet');
  events.forEach((e) => console.log(`- ${e.at.slice(0, 16)} ${e.kind} ${e.detail || ''}`));
}

function queue(status) {
  const rows = d.prepare(`
    SELECT id, source, title, url, company, contact, location, score, offer, angle, raw_json
    FROM leads WHERE status = ? ORDER BY COALESCE(score,-1) DESC, id DESC LIMIT 25`).all(status);
  console.log(`# Leads at stage "${status}" (${rows.length})\n`);
  for (const r of rows) {
    const raw = r.raw_json ? JSON.parse(r.raw_json) : {};
    console.log(`## [${r.id}] ${r.title}`);
    console.log(`- source: ${r.source} | score: ${r.score ?? '--'} | offer: ${r.offer ?? raw.suggestedOffer ?? '?'}`);
    if (r.company) console.log(`- company: ${r.company}`);
    if (r.location) console.log(`- location: ${r.location}`);
    console.log(`- contact: ${r.contact ?? 'none found'}`);
    if (r.url) console.log(`- url: ${r.url}`);
    if (raw.probedWebsite) console.log(`- EXISTING SITE FOUND: ${raw.probedWebsite} (pitch a redesign, not a first site)`);
    if (raw.verificationRequired) console.log(`- ⚠ verify the website claim yourself before drafting anything`);
    if (r.angle) console.log(`- angle: ${r.angle}`);
    if (raw.body) console.log(`\n> ${raw.body.slice(0, 700).replace(/\n/g, '\n> ')}`);
    console.log();
  }
}

function lead(id) {
  const r = d.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!r) return console.log(`No lead ${id}`);
  console.log(`# [${r.id}] ${r.title}\n`);
  for (const [k, v] of Object.entries(r)) {
    if (k === 'raw_json' || v == null) continue;
    console.log(`- **${k}**: ${v}`);
  }
  if (r.raw_json) console.log(`\n## Source payload\n\`\`\`json\n${JSON.stringify(JSON.parse(r.raw_json), null, 2)}\n\`\`\``);
  const msgs = d.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY id').all(id);
  if (msgs.length) {
    console.log('\n## Messages');
    msgs.forEach((m) => console.log(`\n### ${m.direction} / ${m.status} / ${m.created_at.slice(0, 16)}\n${m.body}`));
  }
}

function inbox() {
  const rows = d.prepare(`
    SELECT m.id, m.chat_id, m.body, m.created_at, c.display, c.summary, c.state, c.lead_id
    FROM messages m LEFT JOIN conversations c ON c.chat_id = m.chat_id
    WHERE m.direction='in' AND m.status='received' ORDER BY m.id`).all();
  console.log(`# Unanswered client messages (${rows.length})\n`);
  if (!rows.length) console.log('_inbox clear_');
  for (const r of rows) {
    console.log(`## msg ${r.id} — ${r.display || r.chat_id} (${r.state || 'new'})`);
    if (r.summary) console.log(`_context: ${r.summary}_`);
    console.log(`chat_id: ${r.chat_id}${r.lead_id ? ` | lead: ${r.lead_id}` : ''} | ${r.created_at.slice(0, 16)}`);
    console.log(`\n> ${r.body.replace(/\n/g, '\n> ')}\n`);
    const prior = d.prepare('SELECT direction, body FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT 4').all(r.chat_id, r.id);
    if (prior.length) {
      console.log('Earlier in this thread (newest first):');
      prior.forEach((p) => console.log(`- ${p.direction}: ${p.body.slice(0, 160)}`));
      console.log();
    }
  }
}

const q = arg('queue'), l = arg('lead');
if (q) queue(q); else if (l) lead(Number(l)); else if (flag('inbox')) inbox(); else brief();
