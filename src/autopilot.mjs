#!/usr/bin/env node
// AUTOPILOT: the agents prepare everything and stop one click short.
//
// He asked for full authority, and this is as far as it goes without breaking the law at the top of
// CLAUDE.md. Autopilot selects which drafts are good enough to go, and an agent then places them in
// his real Gmail as drafts. It never calls send. The cost of a bad autonomous send is not a wasted
// message: it is his name and his number on something wrong, in front of a business he wanted, with
// no way to unsend it. A Gmail draft costs one tap and removes that whole class of mistake.
//
// What it prints is a worklist: the messages that cleared every brake and are ready to be drafted
// into Gmail. The CEO cycle does the placing, because only an agent holds the Gmail tool.
//
//   node src/autopilot.mjs --dry-run    show what it WOULD approve
//   node src/autopilot.mjs              approve and send
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, db, now, logEvent, isSuppressed, sentToday, getState, ROOT } from './db.mjs';

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

console.log(`Autopilot ${cfg.autopilot?.enabled ? 'ON' : 'OFF'}${dryRun ? ' (dry run)' : ''} — ${drafts.length} draft(s), ${sentEver} sent all time`);
console.log('Cleared messages are queued for Gmail. Nothing here sends.\n');

let approved = 0;
for (const m of drafts) {
  const lead = m.lead_id ? D.prepare('SELECT * FROM leads WHERE id=?').get(m.lead_id) : null;
  const hold = reasonToHold(m, lead, cfg, sentEver, approved);
  const who = lead?.company || `chat ${m.chat_id}` || '?';
  if (hold) { console.log(`  HOLD  msg ${m.id}  ${String(who).slice(0, 34).padEnd(34)} ${hold}`); continue; }
  console.log(`  SEND  msg ${m.id}  ${String(who).slice(0, 34).padEnd(34)} score ${lead.score}, ${m.channel}`);
  approved++;
  if (!dryRun) {
    D.prepare("UPDATE messages SET delivery='cleared_for_gmail' WHERE id=?").run(m.id);
    logEvent('autopilot_cleared', `msg ${m.id} score ${lead.score} cleared for a Gmail draft`, m.lead_id);
  }
}

if (!dryRun && approved) {
  console.log(`\n${approved} cleared for Gmail. Run /ceo to place them as drafts in your mailbox.`);
} else if (dryRun) {
  console.log(`\n${approved} would be approved. Nothing written.`);
} else {
  console.log('\nNothing approved.');
}
