// Screenshots apps/web (board, then a run in the docked panel or, on a phone, the sheet, then the Skills sheet) in light and dark, at 1280px and
// 375px, into apps/web/screenshots/. Injects apps/web's fixture the way a host does (window.__FACTORY_DATA__), so no /api request is made.
// Fails on horizontal overflow, a console error, or a request off localhost. Same approach as scripts/screenshots.mjs.
// Usage: pnpm --filter @software-factory/web build && pnpm --filter @software-factory/web preview (in another terminal),
// then `pnpm screenshots:web`. Set CHROME=/path/to/chrome to pick a browser.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from './chrome.mjs';

const URL_ = process.env.WEB_URL || 'http://localhost:5200/';
const OUT = path.resolve(import.meta.dirname, '../apps/web/screenshots');
const DATA = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../apps/web/fixtures/state.json'), 'utf8'));
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
    const url = new URL(URL_);
    url.searchParams.set('theme', theme);
    await page.goto(url.href, { waitUntil: 'networkidle' });
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
    await page.waitForSelector(view === 'mobile' ? 'dialog.sf-dialog[open]' : 'aside#detail h2.web-d-title');
    await overflow(view === 'mobile' ? 'run sheet' : 'run panel');
    await save(view === 'mobile' ? 'sheet' : 'panel');
    await page.keyboard.press('Escape'); // close the run, then the Skills sheet
    await page.getByRole('button', { name: 'Skills' }).click();
    await page.waitForSelector('dialog.web-sk[open] .web-sk-table');
    await overflow('skills sheet');
    if (await page.evaluate(() => { const d = document.querySelector('dialog.web-sk'); return d.scrollWidth > d.clientWidth; })) problems.push(`${tag}: the Skills sheet scrolls sideways`);
    await save('skills');
    await ctx.close();
  }
}
await browser.close();
console.log(shots.map((s) => path.relative(process.cwd(), s)).join('\n'));
if (problems.length) { console.error('\n' + problems.join('\n')); process.exit(1); }
console.log(`\n✓ ${shots.length} screenshots; no horizontal overflow, console errors or external requests`);
