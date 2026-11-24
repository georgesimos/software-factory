// desktop(): each harness finds its desktop app on disk, per platform, in fake folders (never the real /Applications).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import claude from '../../adapters/harnesses/claude-code.ts';
import codex from '../../adapters/harnesses/codex.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-desktop-app-')));
const put = (f, text = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const at = (platform, root, home, env = {}) => ({ platform, root, home, env });

test('claude-code desktop(): Claude.app on macOS, the installers\' folders on Windows, a .desktop entry on Linux', () => {
  const root = tmp(), home = path.join(root, 'home');
  assert.deepEqual(claude.desktop(at('darwin', root, home)), { installed: false });
  const user = path.join(home, 'Applications', 'Claude.app'); fs.mkdirSync(user, { recursive: true });
  assert.deepEqual(claude.desktop(at('darwin', root, home)), { installed: true, path: user });
  const sys = path.join(root, 'Applications', 'Claude.app'); fs.mkdirSync(sys, { recursive: true });
  assert.deepEqual(claude.desktop(at('darwin', root, home)), { installed: true, path: sys }); // /Applications first
  const local = path.join(root, 'Local'), pf = path.join(root, 'Program Files');
  assert.deepEqual(claude.desktop(at('win32', root, home, { LOCALAPPDATA: local, ProgramFiles: pf })), { installed: false });
  assert.deepEqual(claude.desktop(at('win32', root, home, {})), { installed: false }); // no env: nothing to look in, no throw
  const exe = put(path.join(pf, 'Claude', 'Claude.exe'));
  assert.deepEqual(claude.desktop(at('win32', root, home, { LOCALAPPDATA: local, ProgramFiles: pf })), { installed: true, path: exe });
  const squirrel = put(path.join(local, 'AnthropicClaude', 'claude.exe'));
  assert.deepEqual(claude.desktop(at('win32', root, home, { LOCALAPPDATA: local, ProgramFiles: pf })), { installed: true, path: squirrel });
  assert.deepEqual(claude.desktop(at('linux', root, home)), { installed: false });
  const entry = put(path.join(home, '.local', 'share', 'applications', 'claude-desktop.desktop'));
  assert.deepEqual(claude.desktop(at('linux', root, home)), { installed: true, path: entry });
});

test('codex desktop(): an app bundle whose id is com.openai.codex (Codex.app or ChatGPT.app); Windows and Linux best effort', () => {
  const root = tmp(), home = path.join(root, 'home');
  put(path.join(root, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist'), '<key>CFBundleIdentifier</key><string>com.openai.chat</string>');
  assert.deepEqual(codex.desktop(at('darwin', root, home)), { installed: false }); // the chat app is not Codex
  put(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist'), 'bplist00\u0000com.openai.codex\u0000'); // binary plist: the id is plain text
  assert.deepEqual(codex.desktop(at('darwin', root, home)), { installed: true, path: path.join(home, 'Applications', 'ChatGPT.app') });
  put(path.join(root, 'Applications', 'Codex.app', 'Contents', 'Info.plist'), '<string>com.openai.codex</string>');
  assert.deepEqual(codex.desktop(at('darwin', root, home)), { installed: true, path: path.join(root, 'Applications', 'Codex.app') });
  const local = path.join(root, 'Local');
  assert.deepEqual(codex.desktop(at('win32', root, home, { LOCALAPPDATA: local })), { installed: false });
  const exe = put(path.join(local, 'Programs', 'Codex', 'Codex.exe'));
  assert.deepEqual(codex.desktop(at('win32', root, home, { LOCALAPPDATA: local })), { installed: true, path: exe });
  const entry = put(path.join(root, 'usr', 'share', 'applications', 'codex.desktop'));
  assert.deepEqual(codex.desktop(at('linux', root, home)), { installed: true, path: entry });
});
