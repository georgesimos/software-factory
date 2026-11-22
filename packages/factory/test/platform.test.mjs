// core/src/platform.ts: how a command resolves on Windows, simulated on any OS (the files are a fake set, not a disk).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command, run } from '../../core/src/platform.ts';

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
