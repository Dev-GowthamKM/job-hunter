#!/usr/bin/env node
// Where the month stands. Read-only.
//
//   node src/money/report.mjs                 this month
//   node src/money/report.mjs --month=2026-08
//   node src/money/report.mjs --goals
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, db } from '../db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const c = JSON.parse(readFileSync(join(ROOT, 'config', 'money.json'), 'utf8'));
const D = db();
const money = (n) => `${c.symbol}${Math.round(Number(n)).toLocaleString('en-IN')}`;
const bar = (used, total, w = 18) => {
  const f = total > 0 ? Math.min(1, used / total) : 0;
  const n = Math.round(f * w);
  return `${'█'.repeat(n)}${'·'.repeat(w - n)}`;
};

function monthReport(month) {
  const b = D.prepare('SELECT * FROM budget_months WHERE month = ?').get(month);
  if (!b) {
    console.log(`# Money — ${month}\n\n_No plan for this month._`);
    console.log(`\nStart one:  node src/money/ledger.mjs plan --month=${month} --amount=<what you have>`);
    return;
  }

  const envs = D.prepare(`
    SELECT e.name, e.kind, e.planned, COALESCE(SUM(t.amount),0) spent
    FROM envelopes e LEFT JOIN transactions t ON t.month=e.month AND t.envelope=e.name
    WHERE e.month = ? GROUP BY e.name, e.kind, e.planned
    ORDER BY CASE e.kind WHEN 'need' THEN 1 WHEN 'want' THEN 2 WHEN 'save' THEN 3 ELSE 4 END, e.name`).all(month);

  const spent = envs.reduce((a, e) => a + e.spent, 0);
  const left = b.allocated - spent;

  // Days remaining drives the only number that actually changes behaviour mid-month.
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = new Date();
  const isCurrent = today.toISOString().slice(0, 7) === month;
  const dayOfMonth = isCurrent ? today.getDate() : daysInMonth;
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);

  console.log(`# Money — ${month}${b.closed_at ? ' (closed)' : ''}\n`);
  console.log(`Allocated **${money(b.allocated)}** · spent **${money(spent)}** · left **${money(left)}**`);
  if (isCurrent && daysLeft > 0) {
    console.log(`\n${daysLeft} days left. That is ${money(left / daysLeft)} a day at the current balance.`);
    const pace = dayOfMonth > 0 ? spent / dayOfMonth : 0;
    const projected = pace * daysInMonth;
    if (projected > b.allocated) {
      console.log(`**At your current pace you finish the month ${money(projected - b.allocated)} over.**`);
    } else {
      console.log(`At your current pace you finish ${money(b.allocated - projected)} under. `);
    }
  }

  console.log(`\n## Envelopes\n`);
  console.log('```');
  for (const e of envs) {
    const over = e.spent > e.planned;
    const tail = over ? `OVER ${money(e.spent - e.planned)}` : `${money(e.planned - e.spent)} left`;
    console.log(`${e.name.padEnd(11)} ${e.kind.padEnd(7)} ${bar(e.spent, e.planned)} ${money(e.spent).padStart(9)} / ${money(e.planned).padStart(9)}  ${tail}`);
  }
  console.log('```');

  const byKind = envs.reduce((a, e) => { (a[e.kind] ||= { planned: 0, spent: 0 }); a[e.kind].planned += e.planned; a[e.kind].spent += e.spent; return a; }, {});
  const savedPlanned = (byKind.save?.planned || 0) + (byKind.invest?.planned || 0);
  const rate = b.allocated ? Math.round(savedPlanned / b.allocated * 100) : 0;
  console.log(`\n## Savings rate\n`);
  console.log(`Plan puts **${rate}%** (${money(savedPlanned)}) into save + invest this month.`);

  const overspent = envs.filter((e) => e.spent > e.planned);
  if (overspent.length) {
    console.log(`\n## Over budget\n`);
    overspent.forEach((e) => console.log(`- **${e.name}**: ${money(e.spent - e.planned)} over. It has to come out of another envelope — pick which.`));
  }

  const recent = D.prepare('SELECT at, envelope, amount, note FROM transactions WHERE month=? ORDER BY id DESC LIMIT 8').all(month);
  if (recent.length) {
    console.log(`\n## Recent\n`);
    recent.forEach((t) => console.log(`- ${t.at.slice(5, 10)} ${money(t.amount).padStart(9)} ${t.envelope}${t.note ? ` — ${t.note}` : ''}`));
  }
}

function goalsReport() {
  const goals = D.prepare('SELECT * FROM money_goals ORDER BY id').all();
  console.log('# Goals\n');
  if (!goals.length) { console.log('_None yet._\n\n`node src/money/ledger.mjs goal add --name="emergency fund" --target=200000 --by=2027-06`'); return; }

  const r = c.projection.assumedAnnualReturn;
  for (const g of goals) {
    const pct = Math.round(g.saved / g.target * 100);
    console.log(`## ${g.name}`);
    console.log(`${money(g.saved)} of ${money(g.target)} — ${pct}%  ${bar(g.saved, g.target, 24)}`);

    if (g.by_date) {
      const months = Math.max(1, Math.round((new Date(`${g.by_date}-01`) - Date.now()) / (30.44 * 86400000)));
      const gap = g.target - g.saved;
      // Plain arithmetic on the rate in config/money.json, which the owner set.
      const monthly = r > 0
        ? gap * (r / 12) / (Math.pow(1 + r / 12, months) - 1)
        : gap / months;
      console.log(`To hit ${g.by_date} (${months} months): **${money(monthly)}/month**`);
      console.log(`_Assumes ${(r * 100).toFixed(1)}% annual return — your figure from config/money.json. Arithmetic, not a forecast._`);
    }
    console.log('');
  }
}

if (flag('goals')) goalsReport();
else monthReport(arg('month', new Date().toISOString().slice(0, 7)));
