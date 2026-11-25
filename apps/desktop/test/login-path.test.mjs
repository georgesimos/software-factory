import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginPath } from '../src/login-path.ts';

const LOGIN = '/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin';
const shell = (seen, out = `motd __SF_PATH__nope__SF_PATH__ from an rc file\n__SF_PATH__${LOGIN}__SF_PATH__`) => (file, args, opts) => { seen.push({ file, args, opts }); return out; };

test('the login shell\'s PATH: after ours (a test\'s stubs win), before launchd\'s bare default; the last marked span', () => {
  const seen = [];
  assert.equal(loginPath({ PATH: '/stubs:/usr/bin', SHELL: '/bin/zsh' }, 'darwin', shell(seen)), '/stubs:/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin');
  assert.equal(loginPath({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, 'linux', shell(seen)), '/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.deepEqual(seen.map((s) => s.file), ['/bin/zsh', '/bin/sh'], '$SHELL, else /bin/sh');
  assert.deepEqual([seen[0].args[0], seen[0].opts.timeout, seen[0].opts.killSignal], ['-ilc', 3000, 'SIGKILL'], 'bounded: an interactive shell ignores SIGTERM');
  assert.match(seen[0].args[1], /"\$PATH"$/);
});

test('fish joins its PATH list with colons; a failing or silent shell, and Windows, keep PATH as it is', () => {
  const seen = [], env = { PATH: '/usr/bin:/bin' };
  loginPath({ ...env, SHELL: '/usr/local/bin/fish' }, 'darwin', shell(seen));
  assert.match(seen[0].args[1], /\(string join : \$PATH\)$/);
  assert.equal(loginPath(env, 'darwin', () => { throw new Error('ETIMEDOUT'); }), '/usr/bin:/bin');
  assert.equal(loginPath(env, 'darwin', () => 'no markers'), '/usr/bin:/bin');
  assert.equal(loginPath({ PATH: 'C:\\npm' }, 'win32', () => assert.fail('no shell on Windows')), 'C:\\npm');
});

test('a login shell\'s PATH is joined with ":" whatever the host: the windows-latest runner tests the darwin branch too', async () => {
  const path = (await import('node:path')).default, host = path.delimiter;
  path.delimiter = ';'; // as on Windows
  try { assert.equal(loginPath({ PATH: '/stubs:/usr/bin', SHELL: '/bin/zsh' }, 'darwin', shell([])), '/stubs:/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin'); }
  finally { path.delimiter = host; }
});
