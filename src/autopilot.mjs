#!/usr/bin/env node
// FULL AUTHORITY MODE. The one place a message becomes sendable without Gowtham tapping approve.
//
// It exists because he asked for it. Every rule here is a brake that still applies, because the cost
// of a bad autonomous send is not a wasted message, it is his name and his phone number on something
// wrong, in front of a business he wanted to work with, with no way to unsend it.
//
//   node src/autopilot.mjs --dry-run    show what it WOULD approve
//   node src/autopilot.mjs              approve and send
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, db, now, logEvent, isSuppressed, sentToday, getState, ROOT } from './db.mjs';
import { sendApproved } from './telegram/outbox.mjs';

const D = db();
const dryRun = process.argv.includes('--dry-run');

function reasonToHold(m, lead, cfg, sentEver, approvedThisRun) {
  const ap = cfg.autopilot;
  if (!ap?.enabled) return 'autopilot is off (config/targets.json -> autopilot.enabled)';
  if (getState('paused', '0') === '1') return 'system paused (/pause in Telegram)';
  if (!ap.channels.includes(m.channel)) return `channel "${m.channel}" is not an autopilot channel`;
  if (!lead) return 'message has no lead attached';
  if (isSuppressed(lead.company, lead.contact, lead.url)) return 'on the do-not-contact list';
  if ((lead.score ?? 0) < ap.minScore) return `score ${lead.score ?? 0} is below minScore ${ap.minScore}`;
  if (ap.requireAngle && !lead.angle) return 'no researched angle';
  if (sentEver < ap.holdFirstN) return `first ${ap.holdFirstN} sends are manual (only ${sentEver} sent so far)`;
  if (sentToday() + approvedThisRun >= ap.dailyCap) return `daily cap of ${ap.dailyCap} reached`;

  const [qStart, qEnd] = ap.quietHours || [];
  if (qStart != null) {
    const hour = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
    const quiet = qStart > qEnd ? (hour >= qStart || hour < qEnd) : (hour >= qStart && hour < qEnd);
    if (quiet) return `quiet hours (${qStart}:00 to ${qEnd}:00 IST), it is ${hour}:00`;
  }

  if (ap.maxPerCompany && lead.company) {
    const already = D.prepare(`SELECT COUNT(*) n FROM messages m JOIN leads l ON l.id = m.lead_id
                               WHERE l.company = ? AND m.status IN ('sent','approved')`).get(lead.company).n;
    if (already >= ap.maxPerCompany) return `already contacted ${lead.company} ${already} time(s)`;
  }
  return null;
}

const cfg = JSON.parse(readFileSync(join(CONFIG, 'targets.json'), 'utf8'));
const drafts = D.prepare("SELECT * FROM messages WHERE status='draft' ORDER BY id").all();
const sentEver = D.prepare("SELECT COUNT(*) n FROM messages WHERE status='sent'").get().n;

console.log(`Autopilot ${cfg.autopilot?.enabled ? 'ON' : 'OFF'}${dryRun ? ' (dry run)' : ''} — ${drafts.length} draft(s), ${sentEver} sent all time\n`);

let approved = 0;
for (const m of drafts) {
  const lead = m.lead_id ? D.prepare('SELECT * FROM leads WHERE id=?').get(m.lead_id) : null;
  const hold = reasonToHold(m, lead, cfg, sentEver, approved);
  const who = lead?.company || `chat ${m.chat_id}` || '?';
  if (hold) { console.log(`  HOLD  msg ${m.id}  ${String(who).slice(0, 34).padEnd(34)} ${hold}`); continue; }
  console.log(`  SEND  msg ${m.id}  ${String(who).slice(0, 34).padEnd(34)} score ${lead.score}, ${m.channel}`);
  approved++;
  if (!dryRun) {
    D.prepare("UPDATE messages SET status='approved' WHERE id=?").run(m.id);
    logEvent('autopilot_approved', `msg ${m.id} score ${lead.score}`, m.lead_id);
  }
}

if (!dryRun && approved) {
  const r = await sendApproved({ verbose: true });
  console.log(`\n${r.sent} sent, ${r.capped} held by the cap.`);
} else if (dryRun) {
  console.log(`\n${approved} would be approved. Nothing written.`);
} else {
  console.log('\nNothing approved.');
}
