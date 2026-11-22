#!/usr/bin/env node
// Drives the setup wizard end to end against `F ui` on a temp FACTORY_DIR, with a fake HOME and stubbed gh, git, claude
// and codex, so it never touches real repos or GitHub. At 375 and 1280 px, light and dark, and as a static file.
// Run: NODE_PATH=<dir containing playwright> node test/onboard.e2e.cjs [screenshot dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const HERE = path.join(__dirname, '..');
let url;
const SHOTS = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'factory-shots-')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-'));
const DIR = path.join(root, 'factory'), HOME = path.join(root, 'home'), clone = path.join(HOME, 'Development', 'app');
fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(path.join(clone, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
const env = { ...process.env, FACTORY_DIR: DIR, FACTORY_TEST: '1', HOME, PATH: `${path.join(HERE, 'test', 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  FACTORY_GH: path.join(HERE, 'test', 'gh-stub.mjs'), FACTORY_GIT: path.join(HERE, 'test', 'git-stub.mjs') };
delete env.CLAUDE_CODE_SESSION_ID;

function startUi() {
  const p = spawn(process.execPath, [path.join(HERE, 'factory.mjs'), 'ui', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', (c) => { out += c; const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(out); if (m) resolve({ p, url: m[0] }); });
    p.on('exit', (code) => reject(new Error('F ui exited ' + code)));
  });
}

let server, browser, last;
(async () => {
  ({ p: server, url } = await startUi());
  browser = await chromium.launch();
  const errors = [], shots = [];
  const open = async (width, scheme) => {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 860 }, colorScheme: scheme });
    const page = (last = await ctx.newPage());
    page.on('pageerror', (e) => errors.push(`${width}/${scheme}: ${e.message}`));
    // 400s are the validation refusals the test provokes and asserts on.
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|status of 400/.test(m.text())) errors.push(`${width}/${scheme} console: ${m.text()}`); });
    return { ctx, page };
  };
  const shot = async (page, name) => { const f = path.join(SHOTS, name + '.png'); await page.screenshot({ path: f }); shots.push(f); };
  const wiz = (page) => page.locator('dialog.ob');
  const status = (page) => wiz(page).locator('.ob-foot .sk-status');
  const next = (page) => wiz(page).locator('[data-k="ob-next"]').click();

  // 1280 light: the whole flow, writing through the endpoints.
  {
    const { ctx, page } = await open(1280, 'light');
    await page.goto(url);
    await wiz(page).waitFor(); // opens by itself: no project attached
    await wiz(page).locator('[data-harness="codex"]').waitFor();
    assert.equal(await wiz(page).locator('[data-harness]').count(), 2);
    assert.match(await wiz(page).locator('[data-harness="claude-code"]').innerText(), /2\.1\.304[^]*Installed[^]*Signed in/);
    await shot(page, '1280-light-1-ai');
    await next(page);
    const card = wiz(page).locator('[data-repo="acme/app"]');
    await card.locator('button', { hasText: 'Attach' }).click();
    await card.locator('.chip', { hasText: 'attached' }).waitFor();
    assert.match(await status(page).innerText(), /Attached acme\/app/);
    // F new exists on main, so the idea card records an idea through POST /idea and hands back an id-only command.
    await wiz(page).locator('[data-k="ob-idea-go"]').click();
    await status(page).filter({ hasText: 'repo must look like owner/name' }).waitFor(); // validated by startIdea: an empty repo is refused
    await wiz(page).locator('[data-k="ob-idea-repo"]').fill('acme/budget');
    await wiz(page).locator('[data-k="ob-idea-text"]').fill('a personal budget app');
    await wiz(page).locator('[data-k="ob-idea-go"]').click();
    await status(page).filter({ hasText: 'Idea recorded for acme/budget:project' }).waitFor();
    assert.match(await wiz(page).locator('.ob-cmd code').last().innerText(), /^\/software-factory new acme\/budget$/);
    assert.match(fs.readFileSync(path.join(DIR, 'events.jsonl'), 'utf8'), /"stage":"idea","status":"started"/);
    await shot(page, '1280-light-2-repo');
    await next(page);
    assert.equal(await wiz(page).locator('[data-k="ob-scope:acme/app"]').getAttribute('aria-pressed'), 'true');
    await wiz(page).locator('[data-ship="web"]').click();
    await status(page).filter({ hasText: 'Saved: web for acme/app' }).waitFor(); // each toggle saves
    await wiz(page).locator('[data-ship="database"]').click();
    await status(page).filter({ hasText: 'Saved: web, database for acme/app' }).waitFor();
    assert.match(await wiz(page).locator('[data-ship="web"]').innerText(), /github-deployments/); // from packages/ship's registry
    assert.match(await wiz(page).locator('[data-ship="mobile"]').innerText(), /no connector yet/);
    await shot(page, '1280-light-3-ship');
    await next(page);
    await wiz(page).locator('[data-k="ob-run:build"]').click();
    const pick = page.locator('dialog.sk-pick');
    await pick.locator('label.sk-opt', { hasText: 'codex exec' }).click();
    await pick.locator('button', { hasText: 'Save' }).click();
    await status(page).filter({ hasText: 'Saved Build' }).waitFor();
    assert.match(await wiz(page).locator('[data-step="build"]').innerText(), /codex exec/);
    await shot(page, '1280-light-4-flow');
    await next(page);
    await wiz(page).locator('select[aria-label="CI"]').selectOption('skip');
    await wiz(page).locator('textarea[aria-label^="Local check"]').fill('pnpm test\npnpm lint');
    await wiz(page).locator('.ob-check input').uncheck();
    await wiz(page).locator('[data-k="ob-step:start"]').click();
    assert.match(await status(page).innerText(), /Unsaved rule changes/); // leaving by the rail doesn't drop typed rules silently
    await wiz(page).locator('.ob-rail li:nth-child(5) button[aria-current="step"]').waitFor();
    await wiz(page).locator('[data-k="ob-rules-save"]').click();
    assert.match(await status(page).innerText(), /A reason is required/);
    assert.ok(!fs.readFileSync(path.join(DIR, 'skills.json'), 'utf8').includes('"rules"'), 'nothing saved without a reason');
    await wiz(page).locator('input[aria-label^="Reason"]').fill('GitHub Actions billing is failing');
    await wiz(page).locator('[data-k="ob-rules-save"]').click();
    await status(page).filter({ hasText: 'Rules saved for acme/app' }).waitFor();
    assert.match(await wiz(page).innerText(), /ci = "skip"[^]*stub-user: GitHub Actions billing is failing/);
    await shot(page, '1280-light-5-rules');
    await next(page);
    assert.match(await wiz(page).locator('[data-out="skills"]').innerText(), /"harness": "codex"/);
    assert.match(await wiz(page).locator('[data-out="rules"]').innerText(), /"value": "skip"/);
    assert.match(await wiz(page).innerText(), /\/software-factory acme\/app#<issue>/);
    await shot(page, '1280-light-6-start');
    await wiz(page).locator('[data-k="ob-next"]', { hasText: 'Finish' }).click();
    await wiz(page).waitFor({ state: 'detached' });
    await ctx.close();
  }
  const projects = JSON.parse(fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8'));
  const skills = JSON.parse(fs.readFileSync(path.join(DIR, 'skills.json'), 'utf8'));
  assert.equal(projects['acme/app'].autoMerge, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DIR, 'onboard.json'), 'utf8'))['acme/app'].ship, ['web', 'database']);
  assert.deepEqual(skills['acme/app'].build, { use: 'provider', harness: 'codex' });
  assert.deepEqual(skills['acme/app'].rules['checks.commands'].value, ['pnpm test', 'pnpm lint']);

  // The other sizes and themes: reopen with "Set up" (a project exists now), walk every step by keyboard.
  for (const [width, scheme] of [[1280, 'dark'], [375, 'light'], [375, 'dark']]) {
    const { ctx, page } = await open(width, scheme);
    await page.goto(url);
    await page.waitForTimeout(300);
    assert.equal(await wiz(page).count(), 0, 'no auto-open once a project is attached');
    await page.locator('[data-k="ob-btn"]').click();
    await wiz(page).locator('[data-harness="codex"]').waitFor();
    for (let i = 0; i < 6; i++) {
      if (i) await page.keyboard.press('Alt+ArrowRight');
      await wiz(page).locator(`.ob-rail li:nth-child(${i + 1}) button[aria-current="step"]`).waitFor();
      assert.doesNotMatch(await wiz(page).innerText(), /\b(null|undefined|NaN)\b/, `${width}px step ${i + 1}: no stray null`);
      assert.ok(await page.evaluate(() => [document.documentElement, document.querySelector('.ob-main')].every((n) => n.scrollWidth <= n.clientWidth)), `${width}px: no horizontal scroll`);
      await shot(page, `${width}-${scheme}-${i + 1}`);
    }
    await page.keyboard.press('Alt+ArrowLeft');
    await wiz(page).locator('.ob-rail li:nth-child(5) button[aria-current="step"]').waitFor();
    await wiz(page).locator('input[aria-label^="Reason"]').fill('typing');
    await page.keyboard.press('Alt+ArrowLeft'); // word navigation inside a field, not a step change
    assert.equal(await wiz(page).locator('input[aria-label^="Reason"]').inputValue(), 'typing');
    await page.reload(); // resumes where it was left
    await page.locator('[data-k="ob-btn"]').click();
    await wiz(page).locator('.ob-rail li:nth-child(5) button[aria-current="step"]').waitFor();
    await page.keyboard.press('Escape');
    await wiz(page).waitFor({ state: 'detached' });
    await ctx.close();
  }

  // Static file: read-only, every step offers the command instead.
  {
    const { ctx, page } = await open(1280, 'light');
    await page.goto('file://' + path.join(DIR, 'dashboard.html'));
    await page.locator('[data-k="ob-btn"]').click();
    assert.match(await wiz(page).innerText(), /Read-only page[^]*npm install -g @openai\/codex[^]*factory\.mjs onboard/);
    await shot(page, '1280-light-static-1');
    await wiz(page).locator('[data-k="ob-step:ship"]').click();
    await wiz(page).locator('[data-ship="mobile"]').click();
    assert.match(await wiz(page).locator('.ob-cmd code').first().innerText(), /onboard ship 'acme\/app' web,mobile,database$/);
    assert.equal(fs.readFileSync(path.join(DIR, 'onboard.json'), 'utf8').includes('mobile'), false); // the static page never writes
    await shot(page, '1280-light-static-3');
    await ctx.close();
  }

  assert.deepEqual(errors, []);
  console.log(`ok - wizard e2e passed; ${shots.length} screenshots in ${SHOTS}`);
})().catch(async (e) => {
  console.error(e);
  try { await last?.screenshot({ path: path.join(SHOTS, 'FAILED.png') }); console.error('page at failure: ' + path.join(SHOTS, 'FAILED.png')); } catch {}
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); server?.kill(); });
