#!/usr/bin/env node
// Drives the app (packages/factory/app.html) as `F ui` serves it: the setup wizard end to end, then the Skills sheet, at 1280
// and 375 px in light and dark; then read-only, as F render writes it, over file://. A temp FACTORY_DIR, a fake HOME and
// stubbed gh, git, claude and codex keep it off real repos, GitHub and ~/.claude/factory.
// Asserts what each write leaves on disk. Rebuild the app with pnpm --filter @software-factory/web dashboard. Set CHROME to pick a browser.
// Run: pnpm --filter @software-factory/factory e2e [screenshot dir]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../scripts/chrome.mjs';

const HERE = path.join(import.meta.dirname, '..');
const SHOTS = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'factory-web-shots-')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-web-e2e-'));
const DIR = path.join(root, 'factory'), HOME = path.join(root, 'home'), clone = path.join(HOME, 'Development', 'app');
fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
fs.writeFileSync(path.join(clone, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
fs.mkdirSync(SHOTS, { recursive: true });
const env = { ...process.env, FACTORY_DIR: DIR, FACTORY_TEST: '1', HOME, USERPROFILE: HOME, PATH: [path.join(HERE, 'test', 'bin'), path.dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(path.delimiter),
  FACTORY_GH: path.join(HERE, 'test', 'gh-stub.mjs'), FACTORY_GIT: path.join(HERE, 'test', 'git-stub.mjs') };
delete env.CLAUDE_CODE_SESSION_ID;
const F = (args, input) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { env, input, stdio: ['pipe', 'pipe', 'inherit'] });
const json = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')), skills = () => json('skills.json');

// Drift: when apps/web has been built here, the committed app.html must be that build (never a stale or hand-merged one).
const built = path.join(HERE, '..', '..', 'apps', 'web', 'dist', 'index.html');
if (fs.existsSync(built)) assert.ok(fs.readFileSync(built).equals(fs.readFileSync(path.join(HERE, 'app.html'))), 'app.html differs from apps/web/dist: run pnpm --filter @software-factory/web dashboard');
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
    const t = setTimeout(() => reject(new Error('F ui printed no URL within 30 s')), 30_000);
    server.stdout.on('data', (c) => { out += c; const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(out); if (m) { clearTimeout(t); resolve(m[0]); } });
    server.on('exit', (code) => { clearTimeout(t); reject(new Error('F ui exited ' + code)); });
  });
  browser = await chromium.launch({ executablePath: findChrome() });
  // 1280 light: no project yet, so the wizard opens by itself; each step writes through /api/onboard/*.
  {
    const { ctx, page } = await open(1280, 'light');
    await page.goto(url);
    const wiz = page.getByRole('dialog', { name: 'Set up the factory' }), status = wiz.locator('.web-ob-foot [role=status]');
    const next = () => wiz.getByRole('button', { name: 'Next' }).click();
    const at = (name) => wiz.locator('.web-ob-rail button[aria-current="step"]', { hasText: name }).waitFor();
    await wiz.locator('[data-harness="codex"]').waitFor();
    assert.equal(await wiz.locator('[data-harness]').count(), 2);
    assert.match(await wiz.locator('[data-harness="claude-code"]').innerText(), /2\.1\.304[^]*Installed[^]*Signed in/);
    await shot(page, '1280-light-1-ai');
    await next();
    await wiz.getByRole('checkbox', { name: /acme\/app/ }).check();
    await wiz.getByRole('button', { name: 'Attach 1 project' }).click();
    await status.filter({ hasText: 'Attached acme/app' }).waitFor();
    await wiz.locator('.sf-ingest-row[data-status="done"]').waitFor();
    await wiz.getByRole('button', { name: 'Record idea' }).click();
    await status.filter({ hasText: 'repo must look like owner/name' }).waitFor(); // validated by startIdea
    await wiz.getByRole('textbox', { name: 'New repo (owner/name)' }).fill('acme/budget');
    await wiz.getByRole('textbox', { name: 'Idea, one line' }).fill('a personal budget app');
    await wiz.getByRole('button', { name: 'Record idea' }).click();
    await status.filter({ hasText: 'Idea recorded for acme/budget:project' }).waitFor();
    assert.equal(await wiz.locator('.web-ob-cmd code').last().innerText(), '/software-factory new acme/budget');
    assert.match(fs.readFileSync(path.join(DIR, 'events.jsonl'), 'utf8'), /"stage":"idea","status":"started"/);
    await shot(page, '1280-light-2-repo');
    await next();
    assert.equal(await wiz.getByRole('button', { name: 'acme/app' }).getAttribute('aria-pressed'), 'true');
    await wiz.getByRole('checkbox', { name: /^Web/ }).check();
    await status.filter({ hasText: 'Saved: web for acme/app' }).waitFor(); // each toggle saves
    await wiz.getByRole('checkbox', { name: /^Desktop/ }).check();
    await status.filter({ hasText: 'Saved: web, desktop for acme/app' }).waitFor();
    assert.match(await wiz.locator('[data-ship="web"]').innerText(), /github-deployments/); // from packages/ship's registry
    assert.match(await wiz.locator('[data-ship="mobile"]').innerText(), /no connector yet/);
    await shot(page, '1280-light-3-ship');
    await next();
    await wiz.getByRole('button', { name: 'Change runner for Build' }).click();
    const pick = page.getByRole('dialog', { name: 'Runner for Build' });
    await pick.locator('label', { hasText: 'codex exec' }).click();
    await pick.getByRole('button', { name: 'Save' }).click();
    await status.filter({ hasText: 'Saved Build.' }).waitFor();
    assert.match(await wiz.locator('[data-step="build"]').innerText(), /codex exec/);
    await shot(page, '1280-light-4-flow');
    await next();
    await wiz.getByRole('combobox', { name: 'CI' }).selectOption('skip');
    await wiz.getByRole('textbox', { name: /^Local check/ }).fill('pnpm test\npnpm lint');
    assert.equal(await wiz.getByRole('checkbox', { name: /auto-merge/ }).isChecked(), false); // D1: off unless turned on
    await wiz.getByRole('button', { name: /Review and start/ }).click();
    await status.filter({ hasText: 'Unsaved rule changes' }).waitFor(); // leaving by the rail doesn't drop typed rules silently
    await at('Rules');
    await wiz.getByRole('button', { name: 'Save rules' }).click();
    await status.filter({ hasText: 'A reason is required' }).waitFor();
    assert.ok(!fs.readFileSync(path.join(DIR, 'skills.json'), 'utf8').includes('"rules"'), 'nothing saved without a reason');
    await wiz.getByRole('textbox', { name: /^Reason/ }).fill('GitHub Actions billing is failing');
    await wiz.getByRole('button', { name: 'Save rules' }).click();
    await status.filter({ hasText: 'Rules saved for acme/app' }).waitFor();
    await wiz.getByText(/ci = "skip"/).waitFor();
    assert.match(await wiz.innerText(), /ci = "skip"[^]*stub-user: GitHub Actions billing is failing/);
    await shot(page, '1280-light-5-rules');
    await next();
    assert.match(await wiz.locator('[data-out="skills"]').innerText(), /"harness": "codex"/);
    assert.match(await wiz.locator('[data-out="rules"]').innerText(), /"value": "skip"/);
    assert.match(await wiz.innerText(), /\/software-factory acme\/app#<issue>/);
    await shot(page, '1280-light-6-start');
    await wiz.getByRole('button', { name: 'Finish' }).click();
    await wiz.waitFor({ state: 'hidden' });
    await ctx.close();
  }
  assert.equal(json('projects.json')['acme/app'].autoMerge, undefined, 'left off: nothing written, and a missing setting is off (D1)');
  assert.deepEqual(json('onboard.json')['acme/app'].ship, ['web', 'desktop']);
  assert.deepEqual(skills()['acme/app'].build, { use: 'provider', harness: 'codex' });
  assert.deepEqual(skills()['acme/app'].rules['checks.commands'].value, ['pnpm test', 'pnpm lint']);

  // 1280 light: every Skills write goes through /api and lands in skills.json.
  {
    const { ctx, page } = await open(1280, 'light');
    await page.goto(url);
    assert.equal(await page.getByRole('dialog', { name: 'Set up the factory' }).count(), 0, 'no auto-open once a project is attached');
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
  // The other sizes and themes: the saved values read back; the wizard walks by keyboard; nothing scrolls sideways.
  for (const [width, scheme] of [[1280, 'dark'], [375, 'light'], [375, 'dark']]) {
    const { ctx, page } = await open(width, scheme);
    await page.goto(url);
    await page.getByRole('button', { name: 'Skills' }).waitFor();
    await noOverflow(page, `${width}px board`);
    await page.getByRole('button', { name: 'Skills' }).click();
    const sheet = page.getByRole('dialog', { name: 'Skills' });
    assert.equal(await sheet.getByRole('combobox', { name: 'Model for Spec' }).inputValue(), 'opus');
    await noOverflow(page, `${width}px skills`);
    await shot(page, `${width}-${scheme}-skills`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Set up' }).click();
    const wiz = page.getByRole('dialog', { name: 'Set up the factory' });
    await wiz.locator('[data-harness="codex"]').waitFor();
    for (let i = 0; i < 6; i++) {
      if (i) await page.keyboard.press('Alt+ArrowRight');
      await wiz.locator(`.web-ob-rail li:nth-child(${i + 1}) button[aria-current="step"]`).waitFor();
      assert.doesNotMatch(await wiz.innerText(), /\b(null|undefined|NaN)\b/, `${width}px step ${i + 1}: no stray null`);
      await noOverflow(page, `${width}px setup step ${i + 1}`);
      await shot(page, `${width}-${scheme}-setup-${i + 1}`);
    }
    await page.keyboard.press('Alt+ArrowLeft');
    await wiz.locator('.web-ob-rail li:nth-child(5) button[aria-current="step"]').waitFor();
    await wiz.getByRole('textbox', { name: /^Reason/ }).fill('typing');
    await page.keyboard.press('Alt+ArrowLeft'); // word navigation inside a field, not a step change
    assert.equal(await wiz.getByRole('textbox', { name: /^Reason/ }).inputValue(), 'typing');
    await page.reload(); // resumes where it was left
    await page.getByRole('button', { name: 'Set up' }).click();
    await wiz.locator('.web-ob-rail li:nth-child(5) button[aria-current="step"]').waitFor();
    await page.keyboard.press('Escape');
    await wiz.waitFor({ state: 'hidden' });
    await ctx.close();
  }
  // Read-only: the page data injected the way a host does, no token. Every step offers the command and nothing is written.
  {
    const { ctx, page } = await open(1280, 'light');
    F(['render']); // the file every record() rewrites
    await page.goto(pathToFileURL(path.join(DIR, 'dashboard.html')).href);
    await page.getByRole('tab', { name: /app/ }).waitFor(); // the run data is inlined; nothing loads from anywhere
    await page.getByRole('button', { name: 'Set up' }).click();
    const wiz = page.getByRole('dialog', { name: 'Set up the factory' });
    assert.match(await wiz.innerText(), /Read-only page[^]*npm install -g @openai\/codex[^]*onboard/);
    await shot(page, '1280-light-static-1');
    await wiz.getByRole('button', { name: /What you ship/ }).click();
    await wiz.getByRole('checkbox', { name: /^Mobile/ }).check();
    assert.match(await wiz.locator('.web-ob-cmd code').first().innerText(), /onboard ship 'acme\/app' web,mobile,desktop$/);
    assert.equal(fs.readFileSync(path.join(DIR, 'onboard.json'), 'utf8').includes('mobile'), false); // the read-only page never writes
    await shot(page, '1280-light-static-3');
    await wiz.getByRole('button', { name: /^Close/ }).click();
    F(['event', 'acme/app#77', 'spec', 'started']); // record() re-renders the file; a title comes from intake only
    await page.getByText('app#77').first().waitFor({ timeout: 15_000 }); // the file re-reads itself every 10 s
    await ctx.close();
  }
  // The claude.ai Artifact: the same app, scrubbed; the host adds the skeleton.
  {
    const { ctx, page } = await open(1280, 'light'), out = path.join(root, 'artifact.html'), wrapped = path.join(root, 'artifact-page.html');
    F(['render', '--artifact', out]);
    fs.writeFileSync(wrapped, `<!doctype html><html><head><meta charset="utf-8"></head><body>${fs.readFileSync(out, 'utf8')}</body></html>`);
    await page.goto(pathToFileURL(wrapped).href);
    await page.getByText('app#77').first().waitFor();
    assert.ok(!(await page.content()).includes(HOME), 'no local path in the published page');
    await ctx.close();
  }
  // Without the token F ui serves nothing, and the API refuses.
  assert.equal((await fetch(url.replace(/\?t=.*/, ''))).status, 403);
  assert.equal((await fetch(url.replace(/\?t=.*/, 'api/state'))).status, 403);
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
