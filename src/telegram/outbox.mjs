#!/usr/bin/env node
// The ONLY code in this project that sends a message to another human.
//
// It reads messages at status='approved' and nothing else. A draft is never sent. The single place a
// row becomes 'approved' is the owner tapping the approve button in their own Telegram chat, handled
// in bridge.mjs. Do not add a status to this query, and do not call it from a sub-agent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, db, now, logEvent, sentToday, ROOT } from '../db.mjs';
import { call, chunk, assertConfigured } from './api.mjs';

export async function sendApproved({ verbose = false } = {}) {
  const cfg = JSON.parse(readFileSync(join(CONFIG, 'targets.json'), 'utf8'));
  const cap = cfg.dailySendCap ?? 20;
  const D = db();

  const queue = D.prepare("SELECT * FROM messages WHERE status='approved' ORDER BY id").all();
  if (!queue.length) { if (verbose) console.log('Nothing approved to send.'); return { sent: 0, capped: 0 }; }

  let sent = 0, capped = 0;
  for (const m of queue) {
    if (sentToday() >= cap) {
      capped++;
      if (verbose) console.log(`Daily cap of ${cap} reached. Message ${m.id} stays queued for tomorrow.`);
      continue;                                   // stays 'approved', goes out on the next run
    }

    // Telegram is the only channel this can actually deliver on. Anything else is handed back to the
    // owner to send from their own account, which is deliberate: an email blast from a script is how
    // a sending domain dies.
    if (m.channel !== 'telegram' || !m.chat_id) {
      D.prepare("UPDATE messages SET status='manual', sent_at=? WHERE id=?").run(now(), m.id);
      logEvent('manual_send_required', `msg ${m.id} on channel ${m.channel}`, m.lead_id);
      if (verbose) console.log(`Message ${m.id} is ${m.channel}, not telegram. Marked for you to send by hand: outbox/`);
      continue;
    }

    try {
      for (const part of chunk(m.body)) await call('sendMessage', { chat_id: m.chat_id, text: part });
      D.prepare("UPDATE messages SET status='sent', sent_at=? WHERE id=?").run(now(), m.id);
      if (m.lead_id) D.prepare("UPDATE leads SET status='sent', updated_at=? WHERE id=? AND status='drafted'").run(now(), m.lead_id);
      logEvent('sent', `msg ${m.id}`, m.lead_id);
      sent++;
      if (verbose) console.log(`Sent message ${m.id}`);
    } catch (err) {
      D.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(err.message, m.id);
      logEvent('send_failed', `msg ${m.id}: ${err.message}`, m.lead_id);
      if (verbose) console.log(`Message ${m.id} failed: ${err.message}`);
    }
  }
  return { sent, capped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertConfigured();
  const r = await sendApproved({ verbose: true });
  console.log(`\n${r.sent} sent, ${r.capped} held by the daily cap.`);
}
