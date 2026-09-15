// Thin Telegram Bot API wrapper. This file and outbox.mjs are the ONLY places the bot token is read.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT } from '../db.mjs';

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) { try { process.loadEnvFile(envPath); } catch { /* Node < 21 */ } }

export const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const OWNER = String(process.env.TELEGRAM_OWNER_ID || '');

export function assertConfigured() {
  if (!TOKEN) {
    console.error(`
No TELEGRAM_BOT_TOKEN found.

  1. Open Telegram and message @BotFather
  2. Send /newbot and follow the prompts
  3. Copy the token it gives you
  4. cp .env.example .env   and paste the token into it yourself

The token is yours. Nothing in this project should ever ask anyone else to type it for you.
`);
    process.exit(1);
  }
}

export async function call(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(`${method}: ${json.description || 'unknown error'}`);
  return json.result;
}

/** Telegram rejects messages over 4096 chars, which a long proposal will hit. */
export function chunk(text, size = 3800) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

export const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
