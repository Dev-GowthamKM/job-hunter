#!/usr/bin/env node
// The ONLY write path the sub-agents use. It cannot send anything: there is no Telegram token read
// here, no sendMessage call, and every message it writes is forced to status='draft'. Moving a draft
// to 'approved' happens in exactly one place — a button tap from the owner's Telegram chat.
//
//   node src/draft.mjs qualify   --lead=42 --score=78 --offer=agents --notes="..."
//   node src/draft.mjs reject    --lead=42 --notes="no budget"
//   node src/draft.mjs research  --lead=42 --angle="..." --notes="..."
//   node src/draft.mjs message   --lead=42 --channel=telegram --body-file=outbox/42.md
//   node src/draft.mjs reply     --chat=12345 --body-file=outbox/reply-12345.md
//   node src/draft.mjs lead      --title="..." --company="..." --contact="..." --notes="..."
//   node src/draft.mjs gmail     --msg=5 --draft-id=... --thread-id=... --url=...
//   node src/draft.mjs replied   --lead=42 --note="asked for a call Thursday"
//   node src/draft.mjs suppress  --pattern="acme.com" --reason="asked not to be contacted"
//   node src/draft.mjs answered  --msg=7
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, now, logEvent, isSuppressed, ROOT, upsertLead } from './db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const cmd = process.argv[2];
const D = db();

function body() {
  const f = arg('body-file');
  if (f) return readFileSync(f.startsWith('/') ? f : join(ROOT, f), 'utf8').trim();
  const b = arg('body');
  if (!b) throw new Error('Provide --body-file=<path> (preferred) or --body="..."');
  return b;
}

function touch(id, fields) {
  const keys = Object.keys(fields);
  D.prepare(`UPDATE leads SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`)
   .run(...keys.map((k) => fields[k]), now(), id);
}

switch (cmd) {
  case 'qualify': {
    const id = Number(arg('lead'));
    const score = Number(arg('score'));
    if (!Number.isFinite(score)) throw new Error('--score is required (0-100)');
    touch(id, { status: 'qualified', score, offer: arg('offer'), notes: arg('notes') });
    logEvent('qualified', `score=${score} offer=${arg('offer')}`, id);
    console.log(`Lead ${id} qualified at ${score} for ${arg('offer')}`);
    break;
  }
  case 'reject': {
    const id = Number(arg('lead'));
    touch(id, { status: 'rejected', score: Number(arg('score') ?? 0), notes: arg('notes') });
    logEvent('rejected', arg('notes') || '', id);
    console.log(`Lead ${id} rejected`);
    break;
  }
  case 'research': {
    const id = Number(arg('lead'));
    touch(id, { status: 'researched', angle: arg('angle'), notes: arg('notes') });
    logEvent('researched', arg('angle') || '', id);
    console.log(`Lead ${id} researched`);
    break;
  }
  case 'message': {
    const id = Number(arg('lead'));
    const lead = D.prepare('SELECT * FROM leads WHERE id=?').get(id);
    if (!lead) throw new Error(`No lead ${id}`);
    if (isSuppressed(lead.company, lead.contact, lead.url)) throw new Error(`Lead ${id} is on the do-not-contact list. No draft written.`);
    const text = body();
    const info = D.prepare(`INSERT INTO messages (lead_id, direction, channel, subject, body, status, created_at)
                            VALUES (?, 'out', ?, ?, ?, 'draft', ?)`)
                  .run(id, arg('channel', 'telegram'), arg('subject'), text, now());
    touch(id, { status: 'drafted' });
    mkdirSync(join(ROOT, 'outbox'), { recursive: true });
    writeFileSync(join(ROOT, 'outbox', `lead-${id}-msg-${info.lastInsertRowid}.md`), text);
    logEvent('drafted', `msg ${info.lastInsertRowid}`, id);
    console.log(`Draft ${info.lastInsertRowid} saved for lead ${id}. Awaiting your approval in Telegram.`);
    break;
  }
  case 'reply': {
    const chat = arg('chat');
    if (!chat) throw new Error('--chat=<telegram chat id> is required');
    const convo = D.prepare('SELECT * FROM conversations WHERE chat_id=?').get(chat);
    const text = body();
    const info = D.prepare(`INSERT INTO messages (lead_id, direction, channel, chat_id, body, status, created_at)
                            VALUES (?, 'out', 'telegram', ?, ?, 'draft', ?)`)
                  .run(convo?.lead_id ?? null, chat, text, now());
    if (arg('summary')) D.prepare('UPDATE conversations SET summary=?, state=? WHERE chat_id=?')
                         .run(arg('summary'), arg('state', 'awaiting_reply'), chat);
    logEvent('reply_drafted', `chat ${chat}`, convo?.lead_id ?? null);
    console.log(`Reply draft ${info.lastInsertRowid} for chat ${chat}. Awaiting your approval.`);
    break;
  }
  case 'answered': {
    D.prepare("UPDATE messages SET status='handled' WHERE id=?").run(Number(arg('msg')));
    console.log(`Inbound message ${arg('msg')} marked handled`);
    break;
  }
  case 'lead': {
    // Hand entry, for the two cases the automated sources cannot cover: a job post the owner pastes
    // in from a platform that forbids scraping, and a business an agent discovers while researching
    // a different lead (Janot turned up this way, underneath a brand that had closed).
    const title = arg('title');
    if (!title) throw new Error('--title is required');
    const slug = (arg('company') || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const { result, id } = upsertLead({
      source: arg('source', 'manual'),
      source_id: arg('source-id', `manual:${slug}:${Date.now().toString(36)}`),
      title,
      url: arg('url'),
      company: arg('company'),
      contact: arg('contact'),
      location: arg('location'),
      raw: { body: arg('notes') || '', suggestedOffer: arg('offer'), enteredBy: arg('by', 'hand'), relevance: 0 },
    });
    if (result === 'duplicate') { console.log(`Already in the pipeline as lead ${id}`); break; }
    logEvent('lead_added', arg('notes') || title, id);
    console.log(`Lead ${id} added: ${title}`);
    break;
  }
  case 'gmail': {
    // Records that an agent placed this message in the owner's real Gmail Drafts. It is NOT sent:
    // a Gmail draft sits in his mailbox until he clicks send himself, which is the approval gate
    // expressed in the tool he already uses rather than a second one he has to learn.
    const id = Number(arg('msg'));
    D.prepare(`UPDATE messages SET gmail_draft_id=?, gmail_thread_id=?, gmail_url=?,
                                   delivery='gmail_draft', status='draft' WHERE id=?`)
     .run(arg('draft-id'), arg('thread-id'), arg('url'), id);
    const m = D.prepare('SELECT lead_id FROM messages WHERE id=?').get(id);
    if (m?.lead_id) D.prepare("UPDATE leads SET status='drafted', updated_at=? WHERE id=?").run(now(), m.lead_id);
    logEvent('gmail_draft', `msg ${id} placed in Gmail drafts`, m?.lead_id ?? null);
    console.log(`Message ${id} is in your Gmail drafts. One click to send.`);
    break;
  }
  case 'replied': {
    // The loop closing. Until this exists a pipeline dead-ends at 'sent' and nobody learns anything.
    const id = Number(arg('lead'));
    D.prepare("UPDATE leads SET status='replied', notes=COALESCE(notes,'') || ?, updated_at=? WHERE id=?")
     .run(`\n[reply] ${arg('note') || ''}`, now(), id);
    logEvent('replied', arg('note') || '', id);
    console.log(`Lead ${id} replied. That is the first one that matters.`);
    break;
  }
  case 'sent-verified': {
    // Only ever set from evidence: the message found in Gmail Sent. Never from a button press.
    const id = Number(arg('msg'));
    D.prepare("UPDATE messages SET status='sent', delivery='verified', sent_at=?, gmail_thread_id=COALESCE(?,gmail_thread_id) WHERE id=?")
     .run(arg('at') || now(), arg('thread-id'), id);
    const m = D.prepare('SELECT lead_id FROM messages WHERE id=?').get(id);
    if (m?.lead_id) D.prepare("UPDATE leads SET status='sent', updated_at=? WHERE id=?").run(now(), m.lead_id);
    logEvent('sent_verified', `msg ${id} confirmed in Gmail Sent`, m?.lead_id ?? null);
    console.log(`Message ${id} confirmed sent.`);
    break;
  }
  case 'park': {
    // Set a lead aside without deleting it. Out-of-market leads are not rejects: the London and
    // New York businesses are real and good, they are simply not where the owner can walk in.
    // Parked is reversible; rejected carries a judgement that was never made about them.
    const id = arg('lead');
    const src = arg('source');
    const from = arg('from-status', 'new');
    const reason = arg('reason') || 'set aside';
    let changed;
    if (id) {
      changed = D.prepare("UPDATE leads SET status='parked', notes=?, updated_at=? WHERE id=?")
                 .run(reason, now(), Number(id)).changes;
    } else if (src) {
      changed = D.prepare("UPDATE leads SET status='parked', notes=?, updated_at=? WHERE source=? AND status=?")
                 .run(reason, now(), src, from).changes;
    } else {
      throw new Error('park needs --lead=<id> or --source=<name> [--from-status=new]');
    }
    logEvent('parked', `${changed} lead(s): ${reason}`);
    console.log(`Parked ${changed} lead(s). Reversible: they keep every field and can be re-qualified.`);
    break;
  }
  case 'suppress': {
    D.prepare('INSERT OR REPLACE INTO suppression (pattern, reason, added_at) VALUES (?,?,?)')
     .run(arg('pattern'), arg('reason'), now());
    logEvent('suppressed', `${arg('pattern')}: ${arg('reason')}`);
    console.log(`"${arg('pattern')}" will never be contacted again`);
    break;
  }
  default:
    console.log('Commands: lead | qualify | reject | research | message | gmail | reply | replied | sent-verified | answered | park | suppress');
    process.exit(1);
}
