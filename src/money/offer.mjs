#!/usr/bin/env node
// What a job offer actually means, after tax, in the currency you spend.
//
// A calculator with its assumptions printed on every run. It is not tax advice, and the slabs in
// config/money.json change with each finance act - check them against the current one before making
// a decision on this output.
//
//   node src/money/offer.mjs --usd=90000
//   node src/money/offer.mjs --usd=90000 --rate=88 --current=780000
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, ROOT } from '../db.mjs';

const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const c = JSON.parse(readFileSync(join(CONFIG, 'money.json'), 'utf8'));
const M = c.offerModel;
const money = (n) => `${c.symbol}${Math.round(n).toLocaleString('en-IN')}`;

/** Indian new-regime slab tax on a taxable figure, plus cess. Slabs come from config. */
export function incomeTax(gross, slabs = M.taxSlabsNewRegime, deduction = M.standardDeduction, cess = M.cessRate) {
  const taxable = Math.max(0, gross - deduction);
  let tax = 0, lower = 0;
  for (const s of slabs) {
    const upper = s.upTo ?? Infinity;
    if (taxable > lower) tax += (Math.min(taxable, upper) - lower) * s.rate;
    lower = upper;
    if (taxable <= lower) break;
  }
  return { taxable, tax: tax * (1 + cess), cess };
}

const usd = Number(arg('usd'));
if (!usd) {
  console.error('usage: node src/money/offer.mjs --usd=<annual USD> [--rate=<USD→INR>] [--current=<your annual take-home INR>]');
  process.exit(1);
}
const rate = Number(arg('rate', M.usdToInr));
const current = arg('current') != null ? Number(arg('current')) : M.currentAnnualTakeHomeInr;

const grossInr = usd * rate;
const { taxable, tax } = incomeTax(grossInr);
const net = grossInr - tax;

console.log(`# Offer: $${usd.toLocaleString('en-US')}/year\n`);
console.log(`Converted at **${rate} INR/USD** — the rate in config/money.json, which you set.\n`);
console.log(`  gross                ${money(grossInr).padStart(14)}`);
console.log(`  standard deduction   ${money(-M.standardDeduction).padStart(14)}`);
console.log(`  taxable              ${money(taxable).padStart(14)}`);
console.log(`  income tax + cess    ${money(-tax).padStart(14)}`);
console.log(`  ${'-'.repeat(36)}`);
console.log(`  take-home / year     ${money(net).padStart(14)}`);
console.log(`  take-home / month    ${money(net / 12).padStart(14)}`);

if (current) {
  const delta = net - current;
  console.log(`\n## Against what you earn now\n`);
  console.log(`  current take-home    ${money(current).padStart(14)}`);
  console.log(`  difference           ${(delta >= 0 ? '+' : '') + money(delta).padStart(13)}  (${(delta / current * 100).toFixed(0)}%)`);
  console.log(`  per month            ${(delta >= 0 ? '+' : '') + money(delta / 12).padStart(13)}`);

  const envs = c.envelopes;
  const savePct = envs.filter((e) => e.kind === 'save' || e.kind === 'invest').reduce((a, e) => a + e.percent, 0);
  const needMonthly = envs.filter((e) => e.kind === 'need').reduce((a, e) => a + e.percent, 0) / 100 * (current / 12);
  const newSaveMonthly = (net / 12) - needMonthly - (envs.filter((e) => e.kind === 'want').reduce((a, e) => a + e.percent, 0) / 100 * (current / 12));
  console.log(`\n## What it does to your plan\n`);
  console.log(`If your needs and wants stay at today's rupee amounts, the surplus available to`);
  console.log(`save or invest becomes **${money(newSaveMonthly)}/month**, against ${savePct}% of your current plan`);
  console.log(`(${money(savePct / 100 * current / 12)}/month).`);
} else {
  console.log(`\n_Set \`offerModel.currentAnnualTakeHomeInr\` in config/money.json (from your payslips) to see`);
  console.log(`this compared against what you earn now._`);
}

console.log(`\n---`);
console.log(`Assumptions: new regime, standard deduction ${money(M.standardDeduction)}, cess ${(M.cessRate * 100).toFixed(0)}%,`);
console.log(`slabs from config/money.json. No surcharge, no 80C, no HRA, no employer PF, no US`);
console.log(`withholding, no foreign-income rules. **This is arithmetic, not tax advice** — verify`);
console.log(`against the current finance act before you decide anything on it.`);
