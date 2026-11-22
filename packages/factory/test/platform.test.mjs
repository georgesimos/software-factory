// core/src/platform.ts: how a command resolves on Windows, simulated on any OS (the files are a fake set, not a disk).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { command, run } from '../../core/src/platform.ts';
import { evalCommand } from '../../core/src/eval.ts';

const files = new Set(['C:\\bin\\gh.exe', 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\tools\\x.bat']);
const win = { platform: 'win32', env: { Path: 'C:\\bin;C:\\Program Files\\nodejs;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, isFile: (p) => [...files].some((f) => f.toLowerCase() === p.toLowerCase()) }; // NTFS ignores case

test('POSIX: the command runs as given', () => {
  assert.deepEqual(command('npm', ['i'], { platform: 'darwin' }), { file: 'npm', args: ['i'] });
  assert.deepEqual(command('npm', ['i', 'a b'], { platform: 'linux' }), { file: 'npm', args: ['i', 'a b'] });
});

test('Windows: an .exe on PATH runs directly, with any arguments', () => {
  assert.deepEqual(command('gh', ['pr', 'view', 'a "b" & c'], win), { file: 'C:\\bin\\gh.exe', args: ['pr', 'view', 'a "b" & c'] });
  assert.deepEqual(command('node.exe', ['-v'], win), { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['-v'] });
});

test('Windows: a .cmd shim runs through cmd.exe /d /s /c, verbatim, with plain arguments only', () => {
  assert.deepEqual(command('npm', ['ci', '--prefer-offline'], win), {
    file: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" ci --prefer-offline"'], windowsVerbatimArguments: true,
  });
  assert.equal(command('x', ['create-next-app@15', '.'], win).args[3], '""C:\\tools\\x.bat" create-next-app@15 ."');
  for (const bad of ['a b', 'a&b', 'a|b', '"q"', '%PATH%', '!x!', '(x)', 'a^b', '<x', '']) {
    assert.throws(() => command('npm', ['i', bad], win), /\.cmd shim.*cmd\.exe quoting/, JSON.stringify(bad));
  }
});

test('Windows: not found stays as given, so the spawn fails with ENOENT ("not installed")', () => {
  assert.deepEqual(command('codex', ['--version'], win), { file: 'codex', args: ['--version'] });
});

test('run() spawns the resolved command', () => {
  const r = run('node', ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  assert.equal(r.stdout, 'ok');
});

test('F eval stops on a claude .cmd shim it cannot pass its arguments to, instead of scoring every fixture "no-outcome"', () => {
  const shim = { ...win, isFile: (p) => p.toLowerCase() === 'c:\\tools\\claude.cmd' };
  assert.throws(() => evalCommand('eval/golden#1', shim), /claude\.cmd is a \.cmd shim/);
  assert.equal(evalCommand('eval/golden#1', { platform: 'darwin' }).file, 'claude');
});

test('factory.mjs on a Node without type stripping prints an upgrade message, not ERR_UNKNOWN_FILE_EXTENSION', () => {
  const entry = path.join(import.meta.dirname, '..', 'factory.mjs');
  let err;
  try { execFileSync(process.execPath, ['--no-experimental-strip-types', entry, 'state'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { err = e; }
  assert.equal(err?.status, 1);
  assert.match(err.stderr, /F needs Node 24\.12 or newer/);
  assert.doesNotMatch(err.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).engines.node, '>=24.12');
});
