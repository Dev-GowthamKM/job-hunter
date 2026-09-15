#!/usr/bin/env node
// ONE place to see everything, across every system sharing this database.
//
// `npm run report` only ever knew about the client pipeline, so a second system (the job-application
// agent and the budget tracker) could run for days with work waiting and nothing would surface it.
// This command is deliberately blind to which system owns a table: it asks every one of them the
// only question that matters, which is "is anything waiting for Gowtham right now?".
import { db } from './db.mjs';

const D = db();
const has = (t) => !!D.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
const one = (sql, ...a) => { try { return D.prepare(sql).get(...a); } catch { return null; } };
const all = (sql, ...a) => { try { return D.prepare(sql).all(...a); } catch { return []; } };

const bar = (n, max, w = 22) => {
  const f = max > 0 ? Math.round((n / max) * w) : 0;
  return '█'.repeat(Math.max(0, Math.min(w, f))) + '·'.repeat(Math.max(0, w - f));
};

const waiting = [];                       // everything that needs Gowtham, from any system
const out = [];

out.push('\x1b[1m  AGENT MONEY MAKER\x1b[0m  ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST');
out.push('');

// ---------------------------------------------------------------- clients
if (has('leads')) {
  const stages = Object.fromEntries(all('SELECT status, COUNT(*) n FROM leads GROUP BY status').map((r) => [r.status, r.n]));
  const total = Object.values(stages).reduce((a, b) => a + b, 0);
  const drafts = one("SELECT COUNT(*) n FROM messages WHERE status IN ('draft','pending')")?.n ?? 0;
  const sent = one("SELECT COUNT(*) n FROM messages WHERE status='sent'")?.n ?? 0;
  const replies = one("SELECT COUNT(*) n FROM messages WHERE direction='in' AND status='received'")?.n ?? 0;

  out.push('\x1b[1m  CLIENT WORK\x1b[0m');
  out.push(`    found ${total}   qualified ${stages.qualified ?? 0}   drafted ${stages.drafted ?? 0}   sent ${sent}   rejected ${stages.rejected ?? 0}`);
  if (drafts)  waiting.push(`${drafts} client message${drafts > 1 ? 's' : ''} written, waiting for you to approve  ->  cat outbox/*.md`);
  if (replies) waiting.push(`${replies} client repl${replies > 1 ? 'ies' : 'y'} unanswered  ->  /ceo inbox`);

  const next = all(`SELECT id, score, company, title FROM leads
                    WHERE status='qualified' ORDER BY score DESC LIMIT 3`);
  if (next.length) {
    out.push('    next up:');
    next.forEach((l) => out.push(`      ${String(l.score).padStart(3)}  ${(l.company || l.title).slice(0, 52)}`));
  }
  out.push('');
}

// ---------------------------------------------------------------- jobs
if (has('applications')) {
  const apps = Object.fromEntries(all('SELECT status, COUNT(*) n FROM applications GROUP BY status').map((r) => [r.status, r.n]));
  const jobs = one('SELECT COUNT(*) n FROM jobs')?.n ?? 0;
  const lastHunt = one("SELECT at FROM events WHERE kind='hunt_run' ORDER BY id DESC LIMIT 1")?.at;

  out.push('\x1b[1m  JOB APPLICATIONS\x1b[0m');
  out.push(`    ${jobs} jobs tracked   ${Object.entries(apps).map(([k, v]) => `${k} ${v}`).join('   ') || 'no packets yet'}`);
  if (lastHunt) out.push(`    last hunt: ${new Date(lastHunt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);

  const pending = all(`SELECT a.id, a.packet_dir, j.company, j.title FROM applications a
                       LEFT JOIN jobs j ON j.id = a.job_id WHERE a.status='awaiting_approval'`);
  pending.forEach((p) => {
    waiting.push(`job application ready to send: ${p.company || '?'} / ${(p.title || '').slice(0, 44)}  ->  ${p.packet_dir || ''}`);
  });
  out.push('');
}

// ---------------------------------------------------------------- money
if (has('money_goals')) {
  const goals = all('SELECT name, target, saved, by_date FROM money_goals');
  if (goals.length) {
    out.push('\x1b[1m  MONEY\x1b[0m');
    goals.forEach((g) => {
      const pct = g.target > 0 ? Math.round((g.saved / g.target) * 100) : 0;
      out.push(`    ${g.name.padEnd(16)} ${bar(g.saved, g.target)} ${pct}%  Rs ${Math.round(g.saved).toLocaleString('en-IN')} of ${Math.round(g.target).toLocaleString('en-IN')}${g.by_date ? `  by ${g.by_date}` : ''}`);
    });
    out.push('');
  }
}

// ---------------------------------------------------------------- the point of the whole command
out.push('\x1b[1m  WAITING FOR YOU\x1b[0m');
if (!waiting.length) out.push('    nothing. every system is idle.');
waiting.forEach((w) => out.push(`    \x1b[33m*\x1b[0m ${w}`));
out.push('');

// ---------------------------------------------------------------- recent activity
const ev = all('SELECT at, kind, lead_id FROM events ORDER BY id DESC LIMIT 6');
if (ev.length) {
  out.push('\x1b[1m  LAST 6 ACTIONS\x1b[0m');
  ev.forEach((e) => out.push(`    ${e.at.slice(0, 16).replace('T', ' ')}  ${e.kind}${e.lead_id ? ` (lead ${e.lead_id})` : ''}`));
  out.push('');
}

console.log(out.join('\n'));
