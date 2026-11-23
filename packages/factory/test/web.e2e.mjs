#!/usr/bin/env node
// Drives apps/web as `F ui` serves it (/app/), against a temp FACTORY_DIR with a fake HOME and stubbed gh, git, claude and
// codex (the same environment as onboard.e2e.cjs), so it never touches real repos, GitHub or ~/.claude/factory.
// Asserts what each write leaves on disk. Needs the build: pnpm --filter @software-factory/web build. Set CHROME to pick a browser.
// Run: pnpm --filter @software-factory/factory e2e:web [screenshot dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../scripts/chrome.mjs';

const HERE = path.join(import.meta.dirname, '..');
const WEB_DIST = path.join(HERE, '..', '..', 'apps', 'web', 'dist'); // not imported from the server: that loads its whole graph here, with the real HOME
if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) { console.error('apps/web is not built: run pnpm --filter @software-factory/web build'); process.exit(1); }
const SHOTS = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'factory-web-shots-')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-web-e2e-'));
const DIR = path.join(root, 'factory'), HOME = path.join(root, 'home');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const env = { ...process.env, FACTORY_DIR: DIR, FACTORY_TEST: '1', HOME, USERPROFILE: HOME, PATH: [path.join(HERE, 'test', 'bin'), path.dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(path.delimiter),
  FACTORY_GH: path.join(HERE, 'test', 'gh-stub.mjs'), FACTORY_GIT: path.join(HERE, 'test', 'git-stub.mjs') };
delete env.CLAUDE_CODE_SESSION_ID;
const skills = () => JSON.parse(fs.readFileSync(path.join(DIR, 'skills.json'), 'utf8'));

const server = spawn(process.execPath, [path.join(HERE, 'factory.mjs'), 'ui', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const errors = [], shots = [];
let last, url, browser;
const open = async (width, scheme) => {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 860 }, colorScheme: scheme, reducedMotion: 'reduce' });
  const page = (last = await ctx.newPage());
  const tag = `${width}/${scheme}`;
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errors.push(`${tag} console: ${m.text()}`); }); // 400s: refusals the test provokes
  page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1') errors.push(`${tag}: external request ${r.url()}`); });
  return { ctx, page };
};
const shot = async (page, name) => { const f = path.join(SHOTS, name + '.png'); await page.screenshot({ path: f }); shots.push(f); };
const noOverflow = async (page, what) => assert.ok(await page.evaluate(() => [document.documentElement, document.querySelector('dialog[open]')].filter(Boolean).every((n) => n.scrollWidth <= n.clientWidth)), `${what}: no horizontal scroll`);

try {
  url = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('F ui printed no /app/ URL within 30 s')), 30_000);
    server.stdout.on('data', (c) => { out += c; const m = /http:\/\/127\.0\.0\.1:\d+\/app\/\?t=[\w-]+/.exec(out); if (m) { clearTimeout(t); resolve(m[0]); } });
    server.on('exit', (code) => { clearTimeout(t); reject(new Error('F ui exited ' + code)); });
  });
  browser = await chromium.launch({ executablePath: findChrome() });
  // 1280 light: every Skills write goes through /api and lands in skills.json.
  {
    const { ctx, page } = await open(1280, 'light');
    await page.goto(url);
    await page.getByText('No runs yet').waitFor();
    await page.getByRole('button', { name: 'Skills' }).click();
    const sheet = page.getByRole('dialog', { name: 'Skills' }), status = sheet.locator('p.web-sk-status').first(); // the sheet's; the picker has its own
    await sheet.getByText('Live: changes save').waitFor();
    await sheet.getByRole('combobox', { name: 'Model for Spec' }).selectOption('opus');
    await status.filter({ hasText: 'Saved.' }).waitFor();
    assert.deepEqual(skills().default.spec, { use: 'default', model: 'opus' });
    await sheet.getByRole('combobox', { name: 'Effort for Spec' }).selectOption('max');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Effort for Spec"]')?.value === 'max');
    assert.deepEqual(skills().default.spec, { use: 'default', model: 'opus', effort: 'max' });
    await sheet.getByRole('button', { name: /Apply all-claude-lean/ }).click();
    await status.filter({ hasText: /Applied all-claude-lean to \d+ steps/ }).waitFor();
    assert.equal(skills().default['review.code'].model, 'sonnet');
    await sheet.getByRole('button', { name: 'Change runner for Build' }).click();
    const pick = page.getByRole('dialog', { name: 'Runner for Build' });
    await pick.locator('label', { hasText: 'codex exec' }).click();
    await pick.getByRole('button', { name: 'Save' }).click();
    await status.filter({ hasText: 'Saved.' }).waitFor();
    assert.deepEqual(skills().default.build, { use: 'provider', harness: 'codex' });
    assert.match(await sheet.locator('tr', { has: page.locator('th', { hasText: /^Build\s*$/ }) }).innerText(), /codex exec/);
    const before = fs.readFileSync(path.join(DIR, 'skills.json'), 'utf8');
    // A refused write shows the server's error and changes nothing.
    await page.route('**/api/skills', (r) => r.continue({ postData: JSON.stringify({ scope: 'default', step: 'intake', runner: { use: 'default', model: 'gpt-6' } }) }));
    await sheet.getByRole('combobox', { name: 'Model for Intake' }).selectOption('haiku');
    await status.filter({ hasText: 'model must be one of' }).waitFor();
    assert.equal(fs.readFileSync(path.join(DIR, 'skills.json'), 'utf8'), before);
    await page.unroute('**/api/skills');
    await shot(page, '1280-light-skills');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    await ctx.close();
  }
  // The other sizes and themes: the same page reads what was saved, and nothing scrolls sideways.
  for (const [width, scheme] of [[1280, 'dark'], [375, 'light'], [375, 'dark']]) {
    const { ctx, page } = await open(width, scheme);
    await page.goto(url);
    await page.getByText('No runs yet').waitFor();
    await noOverflow(page, `${width}px board`);
    await page.getByRole('button', { name: 'Skills' }).click();
    const sheet = page.getByRole('dialog', { name: 'Skills' });
    assert.equal(await sheet.getByRole('combobox', { name: 'Model for Spec' }).inputValue(), 'opus');
    await noOverflow(page, `${width}px skills`);
    await shot(page, `${width}-${scheme}-skills`);
    await ctx.close();
  }
  // Without the token the page can't read /api/state, and says so instead of showing anyone's data.
  {
    const { ctx, page } = await open(1280, 'light');
    await page.goto(url.replace(/\?t=.*/, ''));
    await page.getByText('Could not load runs').waitFor();
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(`ok - web e2e passed; ${shots.length} screenshots in ${SHOTS}`);
} catch (e) {
  console.error(e);
  try { await last?.screenshot({ path: path.join(SHOTS, 'FAILED.png') }); console.error('page at failure: ' + path.join(SHOTS, 'FAILED.png')); } catch { /* the page is gone */ }
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
