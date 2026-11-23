// node-pty 1.1.0's macOS prebuilds ship spawn-helper without the execute bit, so every pty spawn fails with
// "posix_spawnp failed". Sets it on each prebuilt helper under the given node-pty folder (default: this app's).
// Run on install (postinstall) and by scripts/package.mjs on the packaged copy. Windows has no helper.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function chmodHelpers(ptyDir) {
  const pre = path.join(ptyDir, 'prebuilds');
  if (process.platform === 'win32' || !fs.existsSync(pre)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(pre)) {
    const f = path.join(pre, d, 'spawn-helper');
    if (fs.existsSync(f) && !(fs.statSync(f).mode & 0o111)) { fs.chmodSync(f, 0o755); n++; }
  }
  return n;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { chmodHelpers(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))); } catch { /* not installed yet: nothing to fix */ }
}
