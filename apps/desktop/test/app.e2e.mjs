#!/usr/bin/env node
// Launches the built Electron app on `F demo` data: the window shows the board and a run's sessions from the in-process
// server, the page has no Node, nothing off-origin loads, opens or navigates, and closing the window stops the server.
// A temp FACTORY_DIR, a fake HOME and the factory's stub gh, git, claude and codex keep it off real repos and ~/.claude.
// Never clicks Resume: that would spawn a harness. Run: pnpm --filter @software-factory/desktop e2e [screenshot dir]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const app = await _electron.launch({ args: [APP], cwd: APP, env });
const errors = [];
let origin;
try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
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

  // No Node in the page, nothing from another origin, no new windows, no navigation away.
  assert.deepEqual(await win.evaluate(() => [typeof window.process, typeof window.require, typeof window.module]), ['undefined', 'undefined', 'undefined']);
  const other = origin.replace('127.0.0.1', 'localhost'); // the same server under another origin: only the request filter stops it
  assert.equal(await win.evaluate((u) => fetch(u, { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked'), `${other}/`), 'blocked');
  assert.equal(await win.evaluate(() => window.open('http://example.invalid/')), null); // http: denied and not handed to the OS either
  assert.equal(app.windows().length, 1);
  const before = win.url();
  await win.evaluate(() => { location.href = 'http://example.invalid/'; });
  await win.waitForTimeout(500);
  assert.equal(win.url(), before, 'off-origin navigation is refused');
  assert.deepEqual(errors, []);
} finally {
  await app.close();
}
// Closing the window quit the app, and the server with it.
assert.equal(await fetch(`${origin}/`).then(() => 'up', () => 'down'), 'down');
console.log(`desktop e2e: ok (${SHOTS})`);
