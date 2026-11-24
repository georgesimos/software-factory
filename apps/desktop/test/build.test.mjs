import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// A packaged app's code sits under node_modules, where Node refuses to strip types. So the built tree must run from
// there as plain JS, plugins and data files included. `pnpm test` builds it first.
const DIST = path.join(import.meta.dirname, '..', 'dist');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-desktop-'));
const copy = path.join(tmp, 'node_modules', 'factory-desktop');
fs.cpSync(DIST, copy, { recursive: true });
const env = { ...process.env, FACTORY_DIR: path.join(tmp, 'state'), HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home') };
fs.mkdirSync(env.HOME);
const check = (cmd, extra = {}) => {
  const r = spawnSync(cmd, [path.join(import.meta.dirname, 'serve-check.mjs'), copy], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
};
const expect = (r) => {
  assert.equal(r.page, true, 'GET /?t= serves app.html');
  assert.equal(r.noToken, 403);
  assert.deepEqual(r.harnesses, ['claude-code', 'codex'], 'the harness folder loads');
  assert.deepEqual(r.connectors, ['github-deployments'], 'packages/ship and its connectors load');
  assert.ok(r.templates.includes('next-web'), 'the templates are copied');
};

test('the build is plain .mjs JS: no .ts left, every plugin an .mjs file', () => {
  const files = fs.readdirSync(DIST, { recursive: true }).map(String);
  assert.deepEqual(files.filter((f) => f.endsWith('.ts')), []);
  for (const f of ['apps/desktop/src/main.mjs', 'packages/adapters/harnesses/claude-code.mjs', 'packages/adapters/hosts/github.mjs', 'packages/adapters/trackers/github-issues.mjs', 'packages/ship/connectors/github-deployments.mjs', 'packages/factory/app.html',
    ...['harnesses', 'hosts', 'trackers'].map((d) => `packages/adapters/${d}/index.mjs`)]) // each adapter index, every export kept
    assert.ok(files.includes(path.normalize(f)), f);
});

test('the server runs from inside node_modules under plain node', () => expect(check(process.execPath)));

test('…and under Electron’s own Node', () => {
  const electron = createRequire(import.meta.url)('electron'); // the binary's path
  expect(check(electron, { ELECTRON_RUN_AS_NODE: '1' }));
});
