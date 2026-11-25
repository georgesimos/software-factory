// Display-less smoke test of a packaged build (#56): the app's own binary, run as Node (ELECTRON_RUN_AS_NODE), serves
// app.html from its folder with the plugins and connectors loaded, and loads node-pty (spawning a real pty) and the SDK.
// A temp FACTORY_DIR and HOME: nothing touches ~/.claude. Run: pnpm --filter @software-factory/desktop smoke (after package)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.join(import.meta.dirname, '..'), OUT = path.join(HERE, 'out');
const dir = path.join(OUT, `Software Factory-${process.platform}-${process.arch}`);
const [exe, app] = process.platform === 'darwin'
  ? [path.join(dir, 'Software Factory.app', 'Contents', 'MacOS', 'software-factory'), path.join(dir, 'Software Factory.app', 'Contents', 'Resources', 'app')]
  : [path.join(dir, process.platform === 'win32' ? 'software-factory.exe' : 'software-factory'), path.join(dir, 'resources', 'app')];
assert.ok(fs.existsSync(exe), `no packaged app at ${exe}: run package first`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-smoke-')), home = path.join(tmp, 'home');
fs.mkdirSync(home);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', FACTORY_DIR: path.join(tmp, 'state'), HOME: home, USERPROFILE: home };
const run = (args) => {
  const r = spawnSync(exe, args, { env, encoding: 'utf8', timeout: 60_000 });
  process.stderr.write(`--- ${args[0]} status ${r.status} ${r.error?.message ?? ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}\n`); // DIAG
  assert.equal(r.status, 0, `${args[0]}: ${r.stderr || r.error?.message}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
};
const served = run([path.join(HERE, 'test', 'serve-check.mjs'), path.join(app, 'dist')]);
assert.equal(served.page, true, 'GET /?t= serves app.html');
assert.equal(served.noToken, 403);
assert.deepEqual(served.harnesses, ['claude-code', 'codex']);
assert.deepEqual(served.connectors, ['github-deployments']);
assert.ok(served.templates.includes('next-web'));
assert.equal(served.fMissing, true, 'no skill installed: the page says how to install one, not a path inside the app');
const check = path.join(app, '.host-check.mjs');
fs.copyFileSync(path.join(HERE, 'test', 'host-check.mjs'), check);
try { assert.deepEqual(run([check]), { pty: true, sdk: true }); } finally { fs.rmSync(check, { force: true }); }
console.log(`smoke: ok (${served.node}, ${path.relative(HERE, dir)})`);
