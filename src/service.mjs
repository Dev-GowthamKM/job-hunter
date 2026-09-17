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
const PORT = Number(process.env.PORT || 4321);
const TARGET = `gui/${process.getuid()}`;

if (process.platform !== 'darwin') {
  console.error('This installs a macOS launchd agent. On Linux the equivalent is a systemd user\n' +
                'unit; on Windows, Task Scheduler. The server itself runs anywhere.');
  process.exit(1);
}

const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const loaded = () => launchctl('print', `${TARGET}/${LABEL}`).status === 0;

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
  <key>ProcessType</key><string>Background</string>
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

const cmd = process.argv[2] || 'status';

if (cmd === 'install') {
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(LOGDIR, { recursive: true });
  writeFileSync(PLIST, plist());

  // bootout first, so `install` is also how you upgrade an existing one.
  if (loaded()) launchctl('bootout', `${TARGET}/${LABEL}`);
  const r = launchctl('bootstrap', TARGET, PLIST);
  if (r.status !== 0 && !loaded()) {
    console.error(`launchctl bootstrap failed:\n${r.stderr || r.stdout}`);
    process.exit(1);
  }

  process.stdout.write('Starting');
  let state = null;
  for (let i = 0; i < 40 && !state; i++) {
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

} else if (cmd === 'uninstall') {
  if (loaded()) launchctl('bootout', `${TARGET}/${LABEL}`);
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log('Stopped, and it will not come back at login.');
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
}
