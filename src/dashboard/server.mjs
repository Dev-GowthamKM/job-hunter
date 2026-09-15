#!/usr/bin/env node
// The client-acquisition dashboard.  npm run dashboard  then open http://127.0.0.1:4400
//
// Bound to 127.0.0.1 on purpose: it shows prospect contact details and unsent messages, so it is for
// this machine only. Port 4400 because 4321 belongs to the job-application system sharing this folder.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, ROOT } from '../db.mjs';

const HOST = '127.0.0.1';
const PORT = 4400;
const D = db();
const all = (sql, ...a) => { try { return D.prepare(sql).all(...a); } catch { return []; } };
const one = (sql, ...a) => { try { return D.prepare(sql).get(...a); } catch { return null; } };

function state() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'targets.json'), 'utf8')); } catch {}

  const stages = Object.fromEntries(all('SELECT status, COUNT(*) n FROM leads GROUP BY status').map((r) => [r.status, r.n]));
  const drafts = all(`SELECT m.id, m.body, m.subject, m.channel, m.status, l.id AS lead_id,
                             l.company, l.contact, l.score, l.angle, l.location
                      FROM messages m LEFT JOIN leads l ON l.id = m.lead_id
                      WHERE m.status IN ('draft','pending','approved') ORDER BY m.id`);
  const sent = all(`SELECT m.id, m.sent_at, l.company FROM messages m LEFT JOIN leads l ON l.id = m.lead_id
                    WHERE m.status='sent' ORDER BY m.id DESC LIMIT 10`);
  const pipeline = all(`SELECT id, company, title, score, status, offer, angle, contact, source
                        FROM leads WHERE status IN ('qualified','researched','drafted','sent','replied')
                        ORDER BY CASE status WHEN 'replied' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafted' THEN 2
                                 WHEN 'researched' THEN 3 ELSE 4 END, score DESC`);
  const killed = all(`SELECT company, title, substr(notes,1,150) AS notes FROM leads
                      WHERE status='rejected' AND notes IS NOT NULL ORDER BY id DESC LIMIT 12`);
  const events = all('SELECT at, kind, lead_id FROM events ORDER BY id DESC LIMIT 25');

  return {
    now: new Date().toISOString(),
    stages,
    found: Object.values(stages).reduce((a, b) => a + b, 0),
    bySource: all('SELECT source, COUNT(*) n FROM leads GROUP BY source ORDER BY n DESC'),
    drafts, sent, pipeline, killed, events,
    autopilot: cfg.autopilot || { enabled: false },
    paused: one("SELECT value FROM state WHERE key='paused'")?.value === '1',
    inbox: one("SELECT COUNT(*) n FROM messages WHERE direction='in' AND status='received'")?.n ?? 0,
  };
}

createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(state()));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, HOST, () => {
  console.log(`\n  Client pipeline dashboard\n  http://${HOST}:${PORT}\n\n  Ctrl-C to stop.\n`);
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Client Pipeline</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500;600&display=swap">
<style>
:root{--bg:#F2F4F3;--panel:#fff;--line:#C4CCC9;--ink:#14201C;--soft:#4A5A55;--faint:#7C8A85;--accent:#0F6B5C;--human:#B4472E}
@media(prefers-color-scheme:dark){:root{--bg:#0E1513;--panel:#172120;--line:#2C3A37;--ink:#E4EAE7;--soft:#9FB0AB;--faint:#6E807B;--accent:#3FBFA4;--human:#E0764F}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Public Sans",system-ui,sans-serif;font-size:14px;line-height:1.55}
.wrap{max-width:1180px;margin:0 auto;padding:22px 20px 70px}
h1{font-family:"Bricolage Grotesque",sans-serif;font-size:1.5rem;margin:0;letter-spacing:-.02em}
h2{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:34px 0 12px;font-weight:500}
header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:14px}
.mono{font-family:"IBM Plex Mono",monospace}
.tick{font-size:11px;color:var(--faint)}
.funnel{display:flex;gap:0;border:1px solid var(--line);border-radius:3px;overflow:hidden;margin-top:16px;background:var(--panel);flex-wrap:wrap}
.fstep{flex:1;min-width:104px;padding:13px 14px;border-right:1px solid var(--line)}
.fstep:last-child{border-right:0}
.fstep b{display:block;font-family:"Bricolage Grotesque",sans-serif;font-size:1.7rem;line-height:1;font-variant-numeric:tabular-nums}
.fstep span{display:block;margin-top:5px;font-family:"IBM Plex Mono",monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.card{border:1px solid var(--line);border-radius:3px;background:var(--panel);padding:16px;margin-bottom:12px}
.card.hot{border-color:var(--human);border-left-width:3px}
.chead{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:9px}
.cname{font-weight:600;font-size:1rem}
.pill{font-family:"IBM Plex Mono",monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:2px;border:1px solid var(--line);color:var(--faint);white-space:nowrap}
.pill.act{color:var(--human);border-color:var(--human)}
.pill.ok{color:var(--accent);border-color:var(--accent)}
.angle{color:var(--soft);font-size:.9rem;margin:0 0 11px;font-style:italic}
pre.msg{white-space:pre-wrap;font-family:"IBM Plex Mono",monospace;font-size:12px;line-height:1.65;background:var(--bg);border:1px solid var(--line);border-radius:2px;padding:13px;margin:0;overflow-x:auto}
.send-to{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--accent);margin-top:9px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-family:"IBM Plex Mono",monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:500;padding:0 10px 7px 0;border-bottom:1px solid var(--line)}
td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
td.num{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.dim{color:var(--faint)}
.log{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--soft);columns:2;column-gap:28px}
.log div{break-inside:avoid;padding:2px 0}
.empty{color:var(--faint);font-style:italic;padding:10px 0}
.banner{border:1px solid var(--human);border-left-width:3px;border-radius:3px;padding:11px 14px;margin-top:16px;font-size:13px;background:var(--panel)}
@media(max-width:720px){.log{columns:1}}
</style></head><body><div class="wrap">
<header><h1>Client Pipeline</h1><span class="tick mono" id="tick">loading</span></header>
<div id="app"></div></div>
<script>
const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
async function draw(){
  let d; try{ d = await (await fetch('/api/state',{cache:'no-store'})).json(); }
  catch(e){ document.getElementById('tick').textContent='server stopped'; return; }
  const s = d.stages, out = [];

  out.push('<div class="funnel">'+[
    ['found', d.found],['qualified', s.qualified||0],['researched', s.researched||0],
    ['drafted', s.drafted||0],['sent', s.sent||0],['replied', s.replied||0],['rejected', s.rejected||0]
  ].map(([k,v])=>'<div class="fstep"><b>'+v+'</b><span>'+k+'</span></div>').join('')+'</div>');

  if(d.paused) out.push('<div class="banner">System paused. Nothing will send.</div>');
  out.push('<div class="banner">Autopilot <b>'+(d.autopilot.enabled?'ON':'OFF')+'</b>'+
    (d.autopilot.enabled ? ' &middot; agents send on their own, score '+d.autopilot.minScore+'+, '+d.autopilot.dailyCap+'/day, '+(d.autopilot.channels||[]).join('/')+' only'
                         : ' &middot; every message waits for you. Turn on in config/targets.json') + '</div>');

  out.push('<h2>Waiting for you &middot; '+d.drafts.length+'</h2>');
  if(!d.drafts.length) out.push('<p class="empty">No messages waiting.</p>');
  d.drafts.forEach(m=>{
    out.push('<div class="card hot"><div class="chead"><span class="cname">'+esc(m.company||'Reply')+'</span>'+
      '<span><span class="pill act">'+esc(m.status)+'</span> <span class="pill">'+esc(m.channel)+'</span>'+
      (m.score!=null?' <span class="pill ok">score '+m.score+'</span>':'')+'</span></div>'+
      (m.angle?'<p class="angle">'+esc(m.angle)+'</p>':'')+
      (m.subject?'<p class="send-to">Subject: '+esc(m.subject)+'</p>':'')+
      '<pre class="msg">'+esc(m.body)+'</pre>'+
      (m.contact?'<p class="send-to">Send to: '+esc(m.contact)+'</p>':'')+'</div>');
  });

  out.push('<h2>Live leads &middot; '+d.pipeline.length+'</h2>');
  if(!d.pipeline.length) out.push('<p class="empty">Nothing in play.</p>');
  else out.push('<table><thead><tr><th>Score</th><th>Business</th><th>Stage</th><th>Offer</th><th>Contact</th></tr></thead><tbody>'+
    d.pipeline.map(l=>'<tr><td class="num">'+(l.score??'--')+'</td><td>'+esc((l.company||l.title||'').slice(0,52))+
      (l.angle?'<div class="dim" style="font-size:11.5px">'+esc(l.angle.slice(0,104))+'</div>':'')+
      '</td><td class="mono dim">'+esc(l.status)+'</td><td class="mono dim">'+esc(l.offer||'')+
      '</td><td class="mono dim">'+esc((l.contact||'').slice(0,30))+'</td></tr>').join('')+'</tbody></table>');

  out.push('<h2>Recently rejected, and why</h2>');
  out.push(d.killed.length ? '<table><tbody>'+d.killed.map(k=>'<tr><td style="width:180px">'+esc((k.company||k.title||'').slice(0,40))+
    '</td><td class="dim">'+esc(k.notes||'')+'</td></tr>').join('')+'</tbody></table>' : '<p class="empty">Nothing rejected yet.</p>');

  out.push('<h2>Activity</h2><div class="log">'+d.events.map(e=>'<div>'+e.at.slice(0,16).replace('T',' ')+
    '  '+esc(e.kind)+(e.lead_id?' <span class="dim">lead '+e.lead_id+'</span>':'')+'</div>').join('')+'</div>');

  document.getElementById('app').innerHTML = out.join('');
  document.getElementById('tick').textContent = 'updated '+new Date().toLocaleTimeString('en-IN');
}
draw(); setInterval(draw, 10000);
</script></body></html>`;
