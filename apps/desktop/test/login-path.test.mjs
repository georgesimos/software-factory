import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginPath } from '../src/login-path.ts';

test('a Finder, Dock or launcher start keeps its PATH first, then adds the login shell\'s; Windows and a failing shell keep ours', () => {
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, seen = [];
  const run = (sh) => { seen.push(sh); return 'motd from an rc file\n__SF_PATH__/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin__SF_PATH__'; };
  assert.equal(loginPath(env, 'darwin', run), '/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.local/bin');
  assert.equal(loginPath({ PATH: '/usr/bin' }, 'linux', run), '/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin');
  assert.deepEqual(seen, ['/bin/zsh', '/bin/sh'], '$SHELL, else /bin/sh');
  assert.equal(loginPath(env, 'darwin', () => { throw new Error('ETIMEDOUT'); }), '/usr/bin:/bin');
  assert.equal(loginPath(env, 'darwin', () => 'no markers'), '/usr/bin:/bin');
  assert.equal(loginPath({ PATH: 'C:\\npm' }, 'win32', () => assert.fail('no shell on Windows')), 'C:\\npm');
});
