// core/src/platform.ts: how a command resolves on Windows, simulated on any OS (the files are a fake set, not a disk).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { command, linkSkill, open, opener, posixShell, run } from '../../core/src/platform.ts';
import { checkRunner } from '../../core/src/skills.ts';
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

test('posixShell: /bin/sh on POSIX; Git Bash on Windows (env override, else beside git.exe); refuses without one', () => {
  assert.equal(posixShell({ platform: 'linux' }), '/bin/sh');
  const git = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'D:\\g\\bash.exe']);
  const isFile = (p) => git.has(p);
  assert.equal(posixShell({ platform: 'win32', env: { PATH: 'C:\\Program Files\\Git\\cmd' }, isFile }), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(posixShell({ platform: 'win32', env: { PATH: '', CLAUDE_CODE_GIT_BASH_PATH: 'D:\\g\\bash.exe' }, isFile }), 'D:\\g\\bash.exe');
  assert.throws(() => posixShell({ platform: 'win32', env: { PATH: 'C:\\Windows' }, isFile }), /Git for Windows/);
});

test('posixShell finds Git Bash from mingw64\\bin\\git.exe, %ProgramFiles%, or bash.exe on PATH, but never WSL\'s bash', () => {
  const at = (...f) => ({ isFile: (p) => f.includes(p) });
  assert.equal(posixShell({ platform: 'win32', env: { PATH: 'D:\\Git\\mingw64\\bin' }, ...at('D:\\Git\\mingw64\\bin\\git.exe', 'D:\\Git\\bin\\bash.exe') }), 'D:\\Git\\bin\\bash.exe');
  assert.equal(posixShell({ platform: 'win32', env: { PATH: 'C:\\Users\\j\\scoop\\shims', ProgramFiles: 'C:\\Program Files' }, ...at('C:\\Users\\j\\scoop\\shims\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe') }), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(posixShell({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32;E:\\msys\\usr\\bin' }, ...at('C:\\Windows\\System32\\bash.exe', 'E:\\msys\\usr\\bin\\bash.exe') }), 'E:\\msys\\usr\\bin\\bash.exe');
  assert.throws(() => posixShell({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, ...at('C:\\Windows\\System32\\bash.exe') }), /Git for Windows/);
});

test('opener: https, file and claude-cli URLs only, through the OS opener with no shell', () => {
  assert.deepEqual(opener('https://x.test/a?b=1&c=2', 'win32'), { file: 'explorer.exe', args: ['https://x.test/a?b=1&c=2'] });
  assert.deepEqual(opener('file:///tmp/d.html', 'darwin'), { file: 'open', args: ['file:///tmp/d.html'] });
  assert.equal(opener('claude-cli://open', 'linux').file, 'xdg-open');
  for (const bad of ['javascript:alert(1)', 'http://x.test', '/etc/passwd', 'ms-settings:']) assert.throws(() => opener(bad, 'win32'), /refusing|not a URL/, bad);
  for (const prog of ['file:///C:/Users/j/Downloads/x.exe', 'file:///C:/t/x.bat', 'file:///Applications/X.app', 'file:///tmp/x.command', 'file:///tmp/'])
    for (const platform of ['win32', 'darwin', 'linux']) assert.throws(() => opener(prog, platform), /must be \.html pages/, prog);
});

test('open() refuses when this machine has no opener, instead of reporting success', () => {
  assert.throws(() => open('https://x.test', { platform: 'linux', env: { PATH: '/usr/bin' }, isFile: () => false }), /no xdg-open here/);
});

test('linkSkill: links once, is idempotent, and never overwrites a real folder', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-link-')), target = path.join(d, 'factory'), link = path.join(d, 'skills', 'software-factory');
  fs.mkdirSync(target);
  assert.equal(linkSkill(target, link).created, true);
  assert.equal(fs.realpathSync(link), fs.realpathSync(target));
  assert.equal(linkSkill(target, link).created, false);
  const other = path.join(d, 'skills', 'other'); fs.mkdirSync(other);
  assert.throws(() => linkSkill(target, other), /already exists/);
});

test('brief runners accept Windows paths on Windows only: elsewhere C:\\… and ~\\… are relative, so a branch could ship one', () => {
  for (const p of ['C:\\Users\\Jane Doe\\b.md', '~\\briefs\\b.md', '~/b.md', '/x/b.md']) checkRunner({ use: 'brief', path: p }, 't', [], 'win32');
  for (const p of ['~/b.md', '/x/b.md']) checkRunner({ use: 'brief', path: p }, 't', [], 'darwin');
  for (const p of ['C:\\Users\\b.md', 'c:/x/b.md', '~\\briefs\\b.md', 'b.md']) assert.throws(() => checkRunner({ use: 'brief', path: p }, 't', [], 'linux'), /expected/, p);
  assert.throws(() => checkRunner({ use: 'brief', path: 'b.md' }, 't', [], 'win32'));
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
