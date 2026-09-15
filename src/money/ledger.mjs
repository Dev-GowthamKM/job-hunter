#!/usr/bin/env node
// The money ledger. Manual entry, by design: no bank credentials, no account linking, nothing that
// could move a rupee. This file writes rows and does arithmetic. That is all it can do.
//
//   node src/money/ledger.mjs plan  --month=2026-09 --amount=60000
//   node src/money/ledger.mjs spend --envelope=food --amount=450 --note="groceries"
//   node src/money/ledger.mjs goal  add --name="emergency fund" --target=200000 --by=2027-06
//   node src/money/ledger.mjs goal  fund --name="emergency fund" --amount=5000
//   node src/money/ledger.mjs close --month=2026-09
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, db, now, logEvent } from '../db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const cfg = () => JSON.parse(readFileSync(join(ROOT, 'config', 'money.json'), 'utf8'));
const D = db();

export const thisMonth = () => new Date().toISOString().slice(0, 7);
const money = (n, c = cfg()) => `${c.symbol}${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function plan(month, amount) {
  const c = cfg();
  const total = c.envelopes.reduce((a, e) => a + e.percent, 0);
  if (Math.abs(total - 100) > 0.01) {
    console.error(`Envelope percentages total ${total}%, not 100%. Fix config/money.json first.`);
    process.exit(1);
  }

  const existing = D.prepare('SELECT month FROM budget_months WHERE month = ?').get(month);
  D.prepare(`INSERT INTO budget_months (month, allocated, currency, opened_at)
             VALUES (?,?,?,?)
             ON CONFLICT(month) DO UPDATE SET allocated=excluded.allocated`)
    .run(month, amount, c.currency, now());

  const up = D.prepare(`INSERT INTO envelopes (month, name, kind, planned) VALUES (?,?,?,?)
                        ON CONFLICT(month, name) DO UPDATE SET planned=excluded.planned, kind=excluded.kind`);
  for (const e of c.envelopes) up.run(month, e.name, e.kind, Math.round(amount * e.percent / 100));

  logEvent('money_plan', { month, amount });
  console.log(`${existing ? 'Updated' : 'Planned'} ${month}: ${money(amount, c)}\n`);
  for (const e of c.envelopes) {
    console.log(`  ${e.name.padEnd(12)} ${e.kind.padEnd(7)} ${money(Math.round(amount * e.percent / 100), c).padStart(10)}  (${e.percent}%)`);
  }
}

function spend(envelope, amount, note, month) {
  const c = cfg();
  const known = D.prepare('SELECT name FROM envelopes WHERE month = ? AND name = ?').get(month, envelope);
  if (!known) {
    const names = D.prepare('SELECT name FROM envelopes WHERE month = ?').all(month).map((r) => r.name);
    if (!names.length) { console.error(`No plan for ${month}. Run: node src/money/ledger.mjs plan --month=${month} --amount=<n>`); process.exit(1); }
    console.error(`No envelope "${envelope}" in ${month}. Known: ${names.join(', ')}`);
    process.exit(1);
  }
  D.prepare('INSERT INTO transactions (month, at, envelope, amount, note, source) VALUES (?,?,?,?,?,?)')
    .run(month, now(), envelope, amount, note || null, 'manual');

  const planned = D.prepare('SELECT planned FROM envelopes WHERE month=? AND name=?').get(month, envelope).planned;
  const spent = D.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE month=? AND envelope=?').get(month, envelope).s;
  const left = planned - spent;

  console.log(`${money(amount, c)} → ${envelope}${note ? ` (${note})` : ''}`);
  console.log(`  ${envelope}: ${money(spent, c)} of ${money(planned, c)} used · ${left < 0 ? `OVER by ${money(-left, c)}` : `${money(left, c)} left`}`);
  if (left < 0) console.log(`  Over budget. The money has to come from another envelope - decide which, rather than letting it drift.`);
}

function goal(sub) {
  const c = cfg();
  if (sub === 'add') {
    const name = arg('name'), target = Number(arg('target')), by = arg('by');
    if (!name || !target) { console.error('usage: goal add --name="..." --target=<n> [--by=YYYY-MM]'); process.exit(1); }
    D.prepare('INSERT INTO money_goals (name, target, by_date, created_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET target=excluded.target, by_date=excluded.by_date')
      .run(name, target, by || null, now());
    console.log(`Goal "${name}": ${money(target, c)}${by ? ` by ${by}` : ''}`);
  } else if (sub === 'fund') {
    const name = arg('name'), amount = Number(arg('amount'));
    const g = D.prepare('SELECT * FROM money_goals WHERE name = ?').get(name);
    if (!g) { console.error(`No goal "${name}".`); process.exit(1); }
    D.prepare('UPDATE money_goals SET saved = saved + ? WHERE id = ?').run(amount, g.id);
    const saved = g.saved + amount;
    console.log(`"${name}": ${money(saved, c)} of ${money(g.target, c)} (${Math.round(saved / g.target * 100)}%)`);
  } else {
    const goals = D.prepare('SELECT * FROM money_goals ORDER BY id').all();
    if (!goals.length) { console.log('No goals yet.'); return; }
    goals.forEach((g) => console.log(`  ${g.name.padEnd(22)} ${money(g.saved, c).padStart(10)} / ${money(g.target, c).padStart(10)}  ${Math.round(g.saved / g.target * 100)}%${g.by_date ? `  by ${g.by_date}` : ''}`));
  }
}

function close(month) {
  const c = cfg();
  const b = D.prepare('SELECT * FROM budget_months WHERE month = ?').get(month);
  if (!b) { console.error(`No plan for ${month}.`); process.exit(1); }
  const spent = D.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE month=?').get(month).s;
  D.prepare('UPDATE budget_months SET closed_at=? WHERE month=?').run(now(), month);
  const left = b.allocated - spent;
  logEvent('money_close', { month, allocated: b.allocated, spent });
  console.log(`${month} closed. Allocated ${money(b.allocated, c)}, spent ${money(spent, c)}.`);
  console.log(left >= 0 ? `  ${money(left, c)} unspent — decide where it goes before next month opens.` : `  Over by ${money(-left, c)}.`);
}

const cmd = process.argv[2];
const month = arg('month', thisMonth());
if (cmd === 'plan') plan(month, Number(arg('amount')));
else if (cmd === 'spend') spend(arg('envelope'), Number(arg('amount')), arg('note'), month);
else if (cmd === 'goal') goal(process.argv[3]);
else if (cmd === 'close') close(month);
else {
  console.error('usage: node src/money/ledger.mjs <plan|spend|goal|close> [...]');
  process.exit(1);
}
