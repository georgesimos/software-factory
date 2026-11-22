// Screenshots the playground in light and dark, at desktop and 375px, into apps/playground/screenshots/.
// Fails if the page scrolls horizontally at 375px, logs a console error, or requests anything off localhost.
// Usage: pnpm dev (in another terminal), then `pnpm screenshots`. Set CHROME=/path/to/chrome to pick a browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const URL_ = process.env.PLAYGROUND_URL || 'http://localhost:5199/';
const OUT = path.resolve(import.meta.dirname, '../apps/playground/screenshots');
// shortcut: finds a Playwright-installed Chromium or local Chrome; set CHROME if neither is where we look.
const findChrome = () => {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const b of builds) for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac', 'chrome-linux']) {
    for (const exe of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium', 'chrome']) {
      const p = path.join(cache, b, arch, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: findChrome() });
const problems = [];
const shots = [];
const VIEWS = { desktop: { width: 1440, height: 900 }, mobile: { width: 375, height: 812 } };

for (const theme of ['light', 'dark']) {
  for (const [view, viewport] of Object.entries(VIEWS)) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: view === 'mobile' ? 2 : 1, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const tag = `${theme}-${view}`;
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${tag}: console error: ${m.text()}`); });
    page.on('request', (r) => { const h = new URL(r.url()).hostname; if (!['localhost', '127.0.0.1'].includes(h) && !r.url().startsWith('data:')) problems.push(`${tag}: external request ${r.url()}`); });
    await page.goto(`${URL_}?theme=${theme}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.sf-picker-row:not([aria-hidden]) .sf-checkbox'); // discovery mock finished
    await page.evaluate(() => document.fonts.ready);

    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > viewport.width) problems.push(`${tag}: page is ${sw}px wide at a ${viewport.width}px viewport`);

    await page.addStyleTag({ content: '.pg-top { position: static !important; }' }); // keep the sticky bar out of section shots
    const save = async (name, fn) => { const f = path.join(OUT, `${tag}-${name}.png`); await fn(f); shots.push(f); };
    await save('full', (f) => page.screenshot({ path: f, fullPage: true }));
    for (const id of ['tokens', 'basics', 'factory', 'onboarding', 'board', 'detail']) {
      await save(id, (f) => page.locator(`#${id}`).screenshot({ path: f }));
    }
    // Interactive states: run-detail sheet and the command menu.
    await page.locator('#board .sf-run-card', { hasText: 'newsletter' }).first().click();
    await page.waitForSelector('dialog.sf-dialog[open]');
    await save('sheet', (f) => page.screenshot({ path: f }));
    await page.keyboard.press('Escape');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.keyboard.type('acme/shop');
    await page.waitForSelector('.sf-cmdk-item');
    await save('cmdk', (f) => page.screenshot({ path: f }));
    await ctx.close();
  }
}
await browser.close();
console.log(shots.map((s) => path.relative(process.cwd(), s)).join('\n'));
if (problems.length) { console.error('\n' + problems.join('\n')); process.exit(1); }
console.log(`\n✓ ${shots.length} screenshots; no horizontal overflow, console errors or external requests`);
