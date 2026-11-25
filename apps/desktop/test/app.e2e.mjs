#!/usr/bin/env node
// Launches the built Electron app on `F demo` data: the window shows the board and a run's sessions from the in-process
// server, the page has no Node, nothing off-origin loads, opens or navigates, and closing the window stops the server.
// A temp FACTORY_DIR, a fake HOME and the factory's stub gh, git, claude and codex keep it off real repos and ~/.claude.
// Never clicks Resume: that would spawn a harness. Run: pnpm --filter @software-factory/desktop e2e [screenshot dir];
// DESKTOP_EXE=<packaged binary> runs it against a packaged build instead (CI does, on Linux under Xvfb).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';

const APP = path.join(import.meta.dirname, '..');
const FACTORY = path.join(APP, '..', '..', 'packages', 'factory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-desktop-e2e-'));
const SHOTS = path.resolve(process.argv[2] || path.join(root, 'shots'));
const HOME = path.join(root, 'home');
fs.mkdirSync(HOME); fs.mkdirSync(SHOTS, { recursive: true });
const env = { ...process.env, FACTORY_DIR: path.join(root, 'factory'), FACTORY_TEST: '1', HOME, USERPROFILE: HOME,
  PATH: [path.join(FACTORY, 'test', 'bin'), path.dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(path.delimiter),
  FACTORY_GH: path.join(FACTORY, 'test', 'gh-stub.mjs'), FACTORY_GIT: path.join(FACTORY, 'test', 'git-stub.mjs') };
delete env.CLAUDE_CODE_SESSION_ID;
delete env.ELECTRON_RUN_AS_NODE;
execFileSync(process.execPath, [path.join(FACTORY, 'factory.mjs'), 'demo'], { env, stdio: 'ignore' });
const clone = path.join(HOME, 'shop'); // attached, for a terminal session (#58): the stub claude runs in it
fs.mkdirSync(clone);
const pj = path.join(env.FACTORY_DIR, 'projects.json');
fs.writeFileSync(pj, JSON.stringify({ ...(fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : {}), 'acme/shop': { path: clone } }));

const EXE = process.env.DESKTOP_EXE; // a packaged build's binary (scripts/smoke.mjs prints where), else the dev build
const ARGS = EXE ? [] : [APP];
const app = await _electron.launch({ ...(EXE && { executablePath: EXE }), args: ARGS, cwd: APP, env });
const errors = [];
let origin, leftPid = 0;
try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  const blocked = [];
  win.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text())) blocked.push(m.text()); });
  await win.setViewportSize({ width: 1280, height: 860 });
  const url = new URL(win.url());
  origin = url.origin;
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.search, /^\?t=[\w-]{32}$/, 'loaded with the loopback token');

  // Runs, then a run's sessions, both from the server in the main process.
  const t = url.searchParams.get('t');
  const state = await (await fetch(`${origin}/api/state`, { headers: { 'x-factory-token': t } })).json();
  const onboard = await (await fetch(`${origin}/api/onboard`, { method: 'POST', headers: { 'x-factory-token': t, origin, 'content-type': 'application/json' }, body: '{}' })).json();
  assert.deepEqual(onboard.hooks.connectors.map((c) => c.id), ['github-deployments'], 'ship.mjs and its connectors load in the Electron main');
  const run = state.runs.find((r) => r.sessions?.length && !r.archived);
  assert.ok(run, 'the demo data has a run with sessions');
  await win.getByRole('tab', { name: /All/ }).waitFor();
  assert.ok(await win.locator('.web-board').getByText(run.title, { exact: false }).first().isVisible(), 'the board lists the runs');
  await win.evaluate((id) => { location.hash = encodeURIComponent(id); }, run.id);
  const panel = win.getByRole('complementary');
  await panel.getByRole('heading', { name: 'Sessions' }).waitFor();
  await win.screenshot({ path: path.join(SHOTS, 'desktop-run.png') });
  assert.deepEqual(blocked, [], 'the app itself breaks no CSP rule');
  // A terminal session in a real pty (#58): the stub claude's prompt in xterm.js, a typed line echoed back, Stop.
  await win.getByRole('button', { name: 'Sessions' }).click();
  const live = win.getByRole('dialog', { name: 'Sessions' });
  await live.getByRole('combobox', { name: 'Repo' }).selectOption('acme/shop');
  await live.getByRole('button', { name: 'New terminal' }).click();
  const screenText = live.locator('.xterm-rows');
  // The banner's pid, once a terminal other than `not` shows it: the pane switches sessions after the start returns.
  const pidOn = async (not) => {
    for (let i = 0; i < 150; i++) {
      const m = ((await screenText.textContent()) ?? '').match(/stub\s+terminal\s+pid\s+(\d+)/); // xterm may draw spaces as U+00A0
      if (m && Number(m[1]) !== not) return Number(m[1]);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no terminal banner');
  };
  const firstPid = await pidOn(0);
  await win.keyboard.type('hello');
  await win.keyboard.press('Enter');
  await screenText.getByText('you said: hello').waitFor();
  await win.screenshot({ path: path.join(SHOTS, 'desktop-terminal.png') });
  await live.getByRole('listitem').filter({ hasText: 'acme/shop' }).first().getByRole('button', { name: 'Stop' }).click();
  await live.getByText(/exited stopped/).first().waitFor();
  await live.getByRole('button', { name: 'New terminal' }).click(); // left running: quitting must stop it
  leftPid = await pidOn(firstPid);
  await live.getByRole('button', { name: 'Close' }).first().click(); // the sheet's own close: Escape would go to xterm
  await live.waitFor({ state: 'hidden' });

  // No Node in the page, nothing from another origin, no new windows, no navigation away.
  assert.deepEqual(await win.evaluate(() => [typeof window.process, typeof window.require, typeof window.module]), ['undefined', 'undefined', 'undefined']);
  // Run → Approve… belongs to main alone (local-first 5c): no preload, no IPC channel, no server route reaches it.
  // Electron's own channels ('error', and UPPER_SNAKE ones such as IMPORT_SHARED_TEXTURE_…) are left out; _invokeHandlers is where
  // ipcMain.handle keeps its channels.
  assert.deepEqual(await app.evaluate(({ Menu, ipcMain, BrowserWindow, session }) => {
    const run = Menu.getApplicationMenu().items.find((i) => i.label === 'Run');
    const w = BrowserWindow.getAllWindows()[0].webContents;
    return [run?.submenu.items.map((i) => i.label), [...ipcMain.eventNames(), ...(ipcMain._invokeHandlers?.keys() ?? [])].map(String).filter((n) => n !== 'error' && !/^[A-Z_]+$/.test(n)), w.getLastWebPreferences().preload ?? null, session.defaultSession.getPreloads().length];
  }), [['Approve…'], [], null, 0]);
  for (const method of ['GET', 'POST']) assert.equal((await fetch(`${origin}/api/approve`, { method, headers: { 'x-factory-token': t, origin, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).status, 404);
  const other = origin.replace('127.0.0.1', 'localhost'); // the same server under another origin: only the request filter stops it
  assert.equal(await win.evaluate((u) => fetch(u, { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked'), `${other}/`), 'blocked');
  assert.equal(await win.evaluate(() => window.open('http://example.invalid/')), null); // http: denied and not handed to the OS either
  assert.equal(app.windows().length, 1);
  const before = win.url();
  await win.evaluate(() => { location.href = 'http://example.invalid/'; });
  await win.waitForTimeout(500);
  assert.equal(win.url(), before, 'off-origin navigation is refused');
  // The CSP from the main: app.html's own scripts ran (the board is up), anything else is refused.
  assert.equal(await win.evaluate(() => new Promise((r) => { // an injected inline script: refused (Playwright's own evaluate is exempt)
    document.addEventListener('securitypolicyviolation', (e) => r(e.violatedDirective), { once: true });
    const x = document.createElement('script'); x.textContent = 'window.injected = 1'; document.body.append(x);
    setTimeout(() => r(window.injected ? 'ran' : 'silent'), 1000);
  })), 'script-src-elem');
  // The one permission it grants, for the Copy buttons. (Writes this string to the real clipboard.)
  await win.bringToFront();
  assert.equal(await win.evaluate(() => navigator.clipboard.writeText('software-factory e2e').then(() => 'ok', (e) => e.name)), 'ok');
  assert.equal(await win.evaluate(() => navigator.mediaDevices?.getUserMedia({ audio: true }).then(() => 'ok', (e) => e.name) ?? 'none'), 'NotAllowedError');
  // A second launch on the same profile hands over to this one and exits: one server per FACTORY_DIR.
  const second = spawn(app.process().spawnfile, ARGS, { cwd: APP, env, stdio: 'ignore' });
  const code = await Promise.race([new Promise((r) => second.on('exit', r)), new Promise((r) => setTimeout(() => r('still running'), 20_000))]);
  if (code === 'still running') second.kill();
  assert.equal(code, 0, 'the second instance quits');
  assert.equal(app.windows().length, 1);
  assert.deepEqual(errors, []);
} finally {
  await app.close();
}
// Closing the window quit the app, and the server with it.
assert.equal(await fetch(`${origin}/`).then(() => 'up', () => 'down'), 'down');
// And the terminal left running went with it: that stub's own pid, given a moment to go.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
for (let i = 0; i < 50 && alive(leftPid); i++) await new Promise((r) => setTimeout(r, 100));
assert.ok(leftPid > 0 && !alive(leftPid), `the stub claude (pid ${leftPid}) outlives the app`);
console.log(`desktop e2e: ok (${SHOTS})`);
