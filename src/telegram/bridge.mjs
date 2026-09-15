#!/usr/bin/env node
// The Telegram bridge: the owner's control panel and the clients' front door, in one bot.
//
// It does NO reasoning. It is a relay and a queue. It pushes drafts to the owner as approval cards,
// flips a row to 'approved' when the owner taps, logs whatever clients send, and acknowledges them
// immediately so nobody is left staring at silence. The thinking happens in Claude Code, where the
// closer sub-agent drafts the actual replies.
import { db, now, logEvent, getState, setState } from '../db.mjs';
import { call, chunk, esc, OWNER, assertConfigured } from './api.mjs';
import { sendApproved } from './outbox.mjs';

const D = db();
const POLL_SECONDS = 25;

const ACK = "Thanks for reaching out. I've got your message and I'll come back to you shortly with a real answer, not an autoreply.";

// ---------------------------------------------------------------- owner side

async function pushPendingCards() {
  if (!OWNER) return;
  const drafts = D.prepare("SELECT * FROM messages WHERE status='draft' ORDER BY id").all();
  for (const m of drafts) {
    const lead = m.lead_id ? D.prepare('SELECT * FROM leads WHERE id=?').get(m.lead_id) : null;
    const who = lead ? `${lead.company || lead.title}` : `chat ${m.chat_id}`;
    const head = [
      `<b>Draft ${m.id}</b> — ${esc(String(who).slice(0, 70))}`,
      lead ? `score ${lead.score ?? '--'} · ${esc(lead.offer || '?')} · ${esc(lead.source)}` : 'reply to an inbound conversation',
      lead?.url ? esc(lead.url) : '',
      lead?.angle ? `\n<i>${esc(lead.angle.slice(0, 200))}</i>` : '',
      `\n<pre>${esc(m.body.slice(0, 2500))}</pre>`,
    ].filter(Boolean).join('\n');

    try {
      await call('sendMessage', {
        chat_id: OWNER, text: head, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [[
          { text: '✅ Send', callback_data: `ok:${m.id}` },
          { text: '⏭ Skip',  callback_data: `no:${m.id}` },
          { text: '✏️ Edit', callback_data: `ed:${m.id}` },
        ]] },
      });
      D.prepare("UPDATE messages SET status='pending' WHERE id=?").run(m.id);
    } catch (err) {
      console.error(`Could not push draft ${m.id}: ${err.message}`);
    }
  }
}

async function handleCallback(cb) {
  const [action, idRaw] = String(cb.data || '').split(':');
  const id = Number(idRaw);
  const m = D.prepare('SELECT * FROM messages WHERE id=?').get(id);

  if (String(cb.from?.id) !== OWNER) {
    await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not your bot to drive.' });
    return;
  }
  if (!m) {
    await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'That draft is gone.' });
    return;
  }

  if (action === 'ok') {
    // The one and only place a message becomes sendable.
    D.prepare("UPDATE messages SET status='approved' WHERE id=?").run(id);
    logEvent('approved', `msg ${id} by owner`, m.lead_id);
    await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Approved, sending now' });
    const r = await sendApproved();
    await call('sendMessage', { chat_id: OWNER, text: r.sent ? `Sent draft ${id}.` : `Draft ${id} approved but not delivered. Check outbox status.` });
  } else if (action === 'no') {
    D.prepare("UPDATE messages SET status='skipped' WHERE id=?").run(id);
    if (m.lead_id) D.prepare("UPDATE leads SET status='rejected', updated_at=? WHERE id=?").run(now(), m.lead_id);
    logEvent('skipped', `msg ${id} by owner`, m.lead_id);
    await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Skipped' });
  } else if (action === 'ed') {
    D.prepare("UPDATE messages SET status='draft' WHERE id=?").run(id);
    await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Left as a draft' });
    await call('sendMessage', { chat_id: OWNER, text:
      `Draft ${id} is back in the queue. Edit it in Claude Code:\n\n<code>/ceo</code> then ask to redraft message ${id}\n\nIt will come back here when it is rewritten.`,
      parse_mode: 'HTML' });
  }
}

async function ownerCommand(text) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  if (cmd === '/ping') return 'pong. Bridge is up and watching for drafts.';
  if (cmd === '/pause')  { setState('paused', '1'); return 'Paused. Nothing will send until /resume, even if you approve it.'; }
  if (cmd === '/resume') { setState('paused', '0'); return 'Resumed.'; }
  if (cmd === '/pipeline' || cmd === '/brief') {
    const stages = D.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all();
    const pend = D.prepare("SELECT COUNT(*) n FROM messages WHERE status IN ('draft','pending')").get().n;
    const inbox = D.prepare("SELECT COUNT(*) n FROM messages WHERE direction='in' AND status='received'").get().n;
    const sent = D.prepare("SELECT COUNT(*) n FROM messages WHERE status='sent'").get().n;
    return [
      '<b>Pipeline</b>',
      ...stages.map((s) => `${s.status}: ${s.n}`),
      '',
      `awaiting your tap: ${pend}`,
      `unanswered clients: ${inbox}`,
      `sent all time: ${sent}`,
      paused() ? '\n⏸ PAUSED' : '',
    ].filter(Boolean).join('\n');
  }
  return [
    '<b>Commands</b>',
    '/brief — pipeline at a glance',
    '/ping — is the bridge alive',
    '/pause — stop all sending',
    '/resume — start again',
    '',
    'Drafts arrive here as cards. Tap ✅ to send, ⏭ to skip, ✏️ to send it back for a rewrite.',
  ].join('\n');
}

const paused = () => getState('paused', '0') === '1';

// ---------------------------------------------------------------- client side

async function handleClientMessage(msg) {
  const chatId = String(msg.chat.id);
  const display = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || msg.from?.username || chatId;

  const known = D.prepare('SELECT * FROM conversations WHERE chat_id=?').get(chatId);
  if (!known) {
    D.prepare('INSERT INTO conversations (chat_id, display, state, last_seen) VALUES (?,?,?,?)')
     .run(chatId, display, 'open', now());
    logEvent('new_conversation', `${display} (${chatId})`);
  } else {
    D.prepare('UPDATE conversations SET last_seen=?, display=? WHERE chat_id=?').run(now(), display, chatId);
  }

  D.prepare(`INSERT INTO messages (direction, channel, chat_id, body, status, created_at)
             VALUES ('in','telegram',?,?, 'received', ?)`)
   .run(chatId, msg.text || '[non-text message]', now());

  // Acknowledge immediately. A real reply comes from the closer sub-agent on the next /ceo inbox run.
  await call('sendMessage', { chat_id: chatId, text: ACK });

  if (OWNER) {
    await call('sendMessage', { chat_id: OWNER, parse_mode: 'HTML', text:
      `📥 <b>${esc(display)}</b> messaged the bot:\n\n<pre>${esc((msg.text || '').slice(0, 900))}</pre>\n\nRun <code>/ceo inbox</code> to draft a reply.` });
  }
}

// ---------------------------------------------------------------- loop

async function poll() {
  const offset = Number(getState('tg_offset', '0'));
  let updates = [];
  try {
    updates = await call('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] });
  } catch (err) {
    console.error(`getUpdates: ${err.message}`);
    await new Promise((r) => setTimeout(r, 5000));
    return;
  }

  for (const u of updates) {
    setState('tg_offset', u.update_id + 1);
    try {
      if (u.callback_query) { await handleCallback(u.callback_query); continue; }
      const msg = u.message;
      if (!msg?.chat) continue;

      if (OWNER && String(msg.chat.id) === OWNER) {
        const reply = await ownerCommand(msg.text || '');
        await call('sendMessage', { chat_id: OWNER, text: reply, parse_mode: 'HTML' });
      } else if (!OWNER) {
        // Setup aid: without TELEGRAM_OWNER_ID the bot cannot tell you from a client, so it tells
        // whoever messages it what id to put in .env, and stores nothing.
        await call('sendMessage', { chat_id: msg.chat.id, text:
          `This bot is not configured yet.\n\nIf you are the owner, put this in your .env file:\nTELEGRAM_OWNER_ID=${msg.chat.id}\n\nThen restart the bridge.` });
        console.log(`\n  → Your TELEGRAM_OWNER_ID is ${msg.chat.id}. Put it in .env and restart.\n`);
      } else {
        await handleClientMessage(msg);
      }
    } catch (err) {
      console.error(`update ${u.update_id}: ${err.message}`);
    }
  }

  if (!paused()) { await pushPendingCards(); await sendApproved(); }
}

assertConfigured();
const me = await call('getMe');
console.log(`Bridge up as @${me.username}. Client link: https://t.me/${me.username}`);
console.log(OWNER ? `Owner chat: ${OWNER}` : 'No TELEGRAM_OWNER_ID set — message the bot and it will tell you yours.');
console.log('Ctrl-C to stop.\n');
for (;;) await poll();
