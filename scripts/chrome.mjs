import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// shortcut: adapted from scripts/screenshots.mjs (it runs on import); finds a Playwright Chromium in the macOS, Linux or
// Windows cache, else local Chrome on macOS. Set CHROME anywhere else.
export const findChrome = () => {
  if (process.env.CHROME) return process.env.CHROME;
  const caches = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);
  for (const cache of caches) {
    const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const b of builds) for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac', 'chrome-linux', 'chrome-linux64', 'chrome-win', 'chrome-win64']) {
      for (const exe of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium', 'chrome', 'chrome.exe']) {
        const p = path.join(cache, b, arch, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
};
