#!/usr/bin/env node
// Keeps the dashboard running without a terminal window open.
//
//   node src/service.mjs install     start it now, and at every login, forever
//   node src/service.mjs status      is it alive, and is it actually answering
//   node src/service.mjs logs        what it has been saying
//   node src/service.mjs restart     after changing the code
//   node src/service.mjs uninstall   stop it and remove it
//
// This is a launchd user agent, not a daemon. That is deliberate: a daemon runs as root before
// anyone logs in, and this process reads a resume and a budget out of one person's home directory.
// It should run as that person and nobody else.
//
// WHAT "ALWAYS ON" ACTUALLY MEANS HERE. launchd restarts it if it crashes and starts it again at
// every login, so it survives reboots, crashes and closing the terminal. It does not survive the
// Mac being asleep or switched off, because nothing running on this machine can. The server binds
// 127.0.0.1, so it is reachable from this Mac and nowhere else - that is the same privacy
// decision the server makes, not an extra restriction added here.
import { writeFileSync, existsSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { get as httpGet } from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.jobhunter.dashboard';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOGDIR = join(homedir(), 'Library', 'Logs', 'job-hunter');
const LOG = join(LOGDIR, 'dashboard.log');

// The second agent: the daily collection. Separate from the dashboard on purpose - a hunt runs
// for hours and must not be able to take the dashboard down with it when it fails.
const HUNT_LABEL = 'com.jobhunter.daily';
const HUNT_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${HUNT_LABEL}.plist`);
const HUNT_LOG = join(LOGDIR, 'daily.log');
const PORT = Number(process.env.PORT || 4321);
const TARGET = `gui/${process.getuid()}`;

if (process.platform !== 'darwin') {
  console.error('This installs a macOS launchd agent. On Linux the equivalent is a systemd user\n' +
                'unit; on Windows, Task Scheduler. The server itself runs anywhere.');
  process.exit(1);
}

const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const loaded = (label = LABEL) => launchctl('print', `${TARGET}/${label}`).status === 0;

// The node that is running this script is the node the service should use. Resolving it any other
// way - `which node`, a hardcoded /usr/local/bin - breaks the moment Node is upgraded or moved,
// and it breaks silently, as a service that quietly stops coming back after a reboot.
const NODE = process.execPath;

function plist() {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>${esc(join(ROOT, 'src', 'web', 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <!-- Restart it if it exits for any reason, including a port that is busy because the old copy
       has not let go yet. launchd throttles this to one attempt every 10 seconds, so a genuine
       crash loop costs nothing and a transient failure heals itself. -->
  <key>KeepAlive</key><true/>
  <!-- Adaptive, not Background. "Background" is launchd's label for work nobody is waiting on, and
       it comes with throttled disk I/O - wrong for a server whose entire job is answering a person
       who is looking at the page right now. "Adaptive" lets it sit idle cheaply and be promoted
       the moment it has a request in hand. -->
  <key>ProcessType</key><string>Adaptive</string>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>${PORT}</string>
  </dict>
</dict>
</plist>
`;
}

function huntPlist(hour, minute) {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HUNT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>${esc(join(ROOT, 'src', 'jobs', 'daily.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <!-- Not RunAtLoad. This is a two-hour job that hits several dozen job boards; firing it every
       time someone logs in would be rude to those boards and useless to the owner. -->
  <key>RunAtLoad</key><false/>
  <!-- Not KeepAlive either. This one is supposed to finish. KeepAlive on a task that exits is an
       infinite loop against other people's APIs. -->
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(HUNT_LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(HUNT_LOG)}</string>
</dict>
</plist>
`;
}

/**
 * Is the dashboard actually answering, as opposed to merely being a process that exists?
 *
 * Deliberately node:http and not fetch. fetch goes through undici, which reads proxy and agent
 * settings out of the environment - and `npm run` injects twenty npm_config_* variables, which was
 * enough to make this probe fail while the server was demonstrably serving on the same port. A
 * health check for a socket on this machine should not be reroutable by an environment variable.
 */
function answering() {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port: PORT, path: '/api/overview', timeout: 4000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * When the last scheduled collection actually ran.
 *
 * Read from the events table rather than from the log file's timestamp, because the log is
 * appended to by a run that fails immediately just as readily as by one that works.
 */
async function lastDaily() {
  try {
    const { db } = await import('./db.mjs');
    const r = db().prepare("SELECT at, detail FROM events WHERE kind IN ('daily_run','hunt_run') ORDER BY id DESC LIMIT 1").get();
    if (!r) return null;
    const when = new Date(r.at).toLocaleString();
    let d = {};
    try { d = JSON.parse(r.detail || '{}'); } catch { /* older rows stored plain text */ }
    if (d.hunt === false || d.score === false) return `${when} — finished with errors, see the log`;
    if (d.stored != null) return `${when} — ${d.stored} new postings, ${d.dup ?? 0} already known`;
    return when;
  } catch { return null; }
}

const cmd = process.argv[2] || 'status';

if (cmd === 'install') {
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(LOGDIR, { recursive: true });
  writeFileSync(PLIST, plist());

  // bootout first, so `install` is also how you upgrade an existing one.
  //
  // bootout RETURNS BEFORE THE JOB IS GONE. Bootstrapping straight after it races the unload and
  // fails with "Bootstrap failed: 5: Input/output error" - and because the dying job still prints
  // as loaded for a moment, a check for that reports success. The service then finishes unloading
  // and there is nothing left: no process, no registration, and an install that said it worked.
  // That is exactly how a dashboard ends up simply gone. Wait for it.
  if (loaded()) {
    launchctl('bootout', `${TARGET}/${LABEL}`);
    const until = Date.now() + 10000;
    while (loaded() && Date.now() < until) spawnSync('sleep', ['0.2']);
    if (loaded()) { console.error('The old service would not stop. Try: npm run service uninstall'); process.exit(1); }
  }

  const r = launchctl('bootstrap', TARGET, PLIST);
  // Trust the registration, not the exit code: verify the job is really there afterwards.
  if (!loaded()) {
    console.error(`launchctl bootstrap failed:\n${(r.stderr || r.stdout || '').trim() || '(no output)'}`);
    process.exit(1);
  }

  process.stdout.write('Starting');
  let state = null;
  for (let i = 0; i < 120 && !state; i++) {     // 60s: a cold open of a 36MB database is not instant
    await new Promise((r) => setTimeout(r, 500));
    process.stdout.write('.');
    state = await answering();
  }
  console.log('');
  if (!state) {
    console.error(`It did not answer on port ${PORT}. What it said:\n`);
    console.error(existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').slice(-15).join('\n') : '(no log yet)');
    process.exit(1);
  }
  console.log(`Running at http://127.0.0.1:${PORT}  —  ${state.jobs.total} jobs tracked`);
  console.log(`It starts itself at login and restarts itself if it crashes.`);
  console.log(`Logs: ${LOG}`);

} else if (cmd === 'schedule') {
  const at = (process.argv.find((a) => a.startsWith('--at=')) || '--at=07:00').slice(5);
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(at);
  if (!m) { console.error('Use --at=HH:MM, for example --at=07:00'); process.exit(1); }
  const hour = Number(m[1]), minute = Number(m[2] || 0);
  if (hour > 23 || minute > 59) { console.error('That is not a time of day.'); process.exit(1); }

  mkdirSync(dirname(HUNT_PLIST), { recursive: true });
  mkdirSync(LOGDIR, { recursive: true });
  writeFileSync(HUNT_PLIST, huntPlist(hour, minute));
  if (loaded(HUNT_LABEL)) {
    launchctl('bootout', `${TARGET}/${HUNT_LABEL}`);
    const until = Date.now() + 10000;
    while (loaded(HUNT_LABEL) && Date.now() < until) spawnSync('sleep', ['0.2']);
  }
  const r = launchctl('bootstrap', TARGET, HUNT_PLIST);
  if (!loaded(HUNT_LABEL)) {
    console.error(`Could not schedule it:\n${(r.stderr || r.stdout || '').trim() || '(no output)'}`);
    process.exit(1);
  }
  const hh = String(hour).padStart(2, '0'), mm = String(minute).padStart(2, '0');
  console.log(`Collecting every day at ${hh}:${mm}. It collects and scores.`);
  console.log(`Budget about two hours: a measured full run took 124 minutes over 16,614 postings.`);
  console.log(`If the Mac is asleep at ${hh}:${mm}, launchd runs it when the Mac next wakes.`);
  console.log(`It never applies to anything. That still needs you.`);
  console.log(`Logs: ${HUNT_LOG}`);
  console.log(`Run one now without waiting:  npm run service hunt-now`);

} else if (cmd === 'unschedule') {
  if (loaded(HUNT_LABEL)) launchctl('bootout', `${TARGET}/${HUNT_LABEL}`);
  if (existsSync(HUNT_PLIST)) unlinkSync(HUNT_PLIST);
  console.log('No more daily collection. The dashboard is untouched.');

} else if (cmd === 'hunt-now') {
  if (!existsSync(HUNT_PLIST)) { console.error('Not scheduled yet. Run: npm run service schedule'); process.exit(1); }
  launchctl('kickstart', `${TARGET}/${HUNT_LABEL}`);
  console.log(`Started. A measured full run took about two hours.`);
  console.log(`Watch it:  tail -f ${HUNT_LOG}`);

} else if (cmd === 'uninstall') {
  if (loaded()) launchctl('bootout', `${TARGET}/${LABEL}`);
  if (existsSync(PLIST)) unlinkSync(PLIST);
  if (loaded(HUNT_LABEL)) launchctl('bootout', `${TARGET}/${HUNT_LABEL}`);
  if (existsSync(HUNT_PLIST)) unlinkSync(HUNT_PLIST);
  console.log('Stopped, and it will not come back at login. The daily collection is off too.');
  console.log(`Your data is untouched. Start it by hand any time with: npm run web`);

} else if (cmd === 'restart') {
  if (!existsSync(PLIST)) { console.error('Not installed. Run: npm run service install'); process.exit(1); }
  launchctl('kickstart', '-k', `${TARGET}/${LABEL}`);
  const state = await (async () => { for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 500)); const s = await answering(); if (s) return s; } return null; })();
  console.log(state ? `Restarted. http://127.0.0.1:${PORT}` : 'Restarted, but it is not answering yet. Check: npm run service logs');

} else if (cmd === 'logs') {
  if (!existsSync(LOG)) { console.log(`Nothing logged yet: ${LOG}`); process.exit(0); }
  try { execFileSync('tail', ['-n', '40', LOG], { stdio: 'inherit' }); } catch { /* tail exit */ }
  console.log(`\n(${LOG})`);

} else {
  const isLoaded = loaded();
  const state = await answering();
  console.log(`installed   ${existsSync(PLIST) ? 'yes' : 'no'}`);
  console.log(`registered  ${isLoaded ? 'yes, starts at login' : 'no'}`);
  console.log(`answering   ${state ? `yes — http://127.0.0.1:${PORT}, ${state.jobs.total} jobs tracked` : 'no'}`);
  if (isLoaded && !state) console.log(`\nRegistered but not answering. Check: npm run service logs`);
  if (!existsSync(PLIST)) console.log(`\nTo keep it running: npm run service install`);

  console.log('');
  if (existsSync(HUNT_PLIST) && loaded(HUNT_LABEL)) {
    const t = /<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/
      .exec(readFileSync(HUNT_PLIST, 'utf8'));
    const when = t ? `${String(t[1]).padStart(2, '0')}:${String(t[2]).padStart(2, '0')}` : 'a set time';
    console.log(`collecting   every day at ${when}`);
    const last = await lastDaily();
    console.log(`last run     ${last || 'not yet'}`);
  } else {
    console.log(`collecting   no — the job count will not change on its own`);
    console.log(`             turn it on: npm run service schedule`);
  }
}
