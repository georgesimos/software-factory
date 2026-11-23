// Screenshots apps/web (board + run sheet) in light and dark, at 1280px and 375px, into apps/web/screenshots/.
// Injects the playground's demo data the way a host does (window.__FACTORY_DATA__), so no /api request is made.
// Fails on horizontal overflow, a console error, or a request off localhost. Same approach as scripts/screenshots.mjs.
// Usage: pnpm --filter @software-factory/web build && pnpm --filter @software-factory/web preview (in another terminal),
// then `pnpm screenshots:web`. Set CHROME=/path/to/chrome to pick a browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const URL_ = process.env.WEB_URL || 'http://localhost:5200/';
const OUT = path.resolve(import.meta.dirname, '../apps/web/screenshots');
const DATA = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../apps/playground/src/fixtures/demo.json'), 'utf8'));
// shortcut: adapted from scripts/screenshots.mjs (it runs on import); finds a Playwright Chromium in the macOS, Linux or
// Windows cache, else local Chrome on macOS. Set CHROME anywhere else.
const findChrome = () => {
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

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: findChrome() });
const problems = [];
const shots = [];
const VIEWS = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } };

for (const theme of ['light', 'dark']) {
  for (const [view, viewport] of Object.entries(VIEWS)) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: view === 'mobile' ? 2 : 1, colorScheme: theme, reducedMotion: 'reduce' });
    await ctx.addInitScript((d) => { window.__FACTORY_DATA__ = d; }, DATA);
    const page = await ctx.newPage();
    const tag = `${theme}-${view}`;
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${tag}: console error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`${tag}: page error: ${e.message}`));
    page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && !['localhost', '127.0.0.1'].includes(u.hostname)) problems.push(`${tag}: external request ${r.url()}`); });
    await page.goto(`${URL_}?theme=${theme}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.web-col .sf-run-card');
    await page.evaluate(() => document.fonts.ready);
    const overflow = async (what) => {
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      if (sw > viewport.width) problems.push(`${tag}: ${what} is ${sw}px wide at a ${viewport.width}px viewport`);
    };
    await overflow('board');
    const save = async (name) => { const f = path.join(OUT, `${tag}-${name}.png`); await page.screenshot({ path: f, fullPage: name === 'board' }); shots.push(f); };
    await save('board');
    await page.locator('.sf-run-card', { hasText: 'newsletter' }).first().click();
    await page.waitForSelector('dialog.sf-dialog[open]');
    await overflow('run sheet');
    await save('sheet');
    await ctx.close();
  }
}
await browser.close();
console.log(shots.map((s) => path.relative(process.cwd(), s)).join('\n'));
if (problems.length) { console.error('\n' + problems.join('\n')); process.exit(1); }
console.log(`\n✓ ${shots.length} screenshots; no horizontal overflow, console errors or external requests`);
