import fs from 'node:fs';
import path from 'node:path';
import { axesFor, decide, gate, type Facts } from './gate.ts';
import { dashboard } from './log.ts';
import { dayOf, rules } from './rules.ts';
import { facts, intake } from './github.ts';
import { getRun } from './derive.ts';
import { io, log, read, stateDir } from './log.ts';
import { readSkills, writeSkills } from './skills.ts';
import { reviewFromText } from './review.ts';
import type { FactoryEvent, Rule, Runner } from './types.ts';

// Fixture runs covering every outcome; used by `demo` and `test`.
export function demo() {
  let t = Date.parse('2026-11-20T09:00:00Z');
  const S = { harness: 'claude-code', sessionId: 'demo-session', cwd: '/work/shop' }, MEASURED = ['acme/shop#43', 'acme/shop#45'];
  const ev = (run: string, stage: string, status: string, p: Record<string, unknown> = {}) => {
    const e = { ts: new Date((t += 97_000)).toISOString(), ...p, ...(MEASURED.includes(run) && stage !== 'ship' ? S : {}), run, stage, status };
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(log(), JSON.stringify(e) + '\n');
  };
  const intake = (run: string, title: string, n: number, association = 'OWNER') =>
    ev(run, 'intake', 'started', { title, url: `https://github.com/acme/shop/issues/${n}`, author: association === 'OWNER' ? 'acme' : 'drive-by', association });
  const pass = (run: string, axes: string[], usage?: boolean) => axes.forEach((axis, i) => ev(run, 'review', 'passed', { axis, findings: [], ...(usage ? { usage: { input: 9 + i, output: 2400 + 300 * i, cacheRead: 38000, cacheWrite: 9000 }, model: 'claude-sonnet-5-5', tokens: 49409 + 301 * i } : {}) }));
  const g = (run: string, extra?: Record<string, unknown>) => { const { status, ...p } = gate(getRun(run)); ev(run, 'gate', status, { ...p, ...extra }); };
  const d = (run: string, facts: Facts) => { const x = decide(getRun(run), facts); ev(run, 'approve', 'decided', x); return x; };

  let R = 'acme/shop#41';
  intake(R, 'Make the site support crypto payments', 41, 'NONE');
  ev(R, 'intake', 'rejected', { reason: 'Out of scope: the roadmap excludes payment providers and the issue has no user need behind it.' });

  R = 'acme/shop#42';
  intake(R, 'Search is slow', 42);
  ev(R, 'intake', 'needs-info', { questions: ['Which page: product search or admin search?', 'Roughly how slow, and on what data size?'] });

  R = 'acme/shop#43';
  intake(R, 'Add newsletter signup to footer', 43);
  ev(R, 'intake', 'passed', { summary: 'Worth building: small, clear value, fits existing Subscribe component.' });
  ev(R, 'spec', 'passed', { spec: 'Footer form reusing Subscribe; inline success/error; no new deps.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/90', branch: 'factory/issue-43' });
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'] });
  pass(R, ['code', 'security', 'seo']);
  ev(R, 'review', 'failed', { axis: 'ux', tokens: 41000, costUsd: 0.31, findings: [{ severity: 'high', file: 'components/Footer.tsx', issue: 'Spec never says what happens for an already-subscribed email.', route: 'spec' }] });
  ev(R, 'review', 'passed', { axis: 'ui', findings: [] });
  g(R);
  ev(R, 'spec', 'passed', { spec: 'Adds: already-subscribed shows a neutral "You are on the list" message.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed');
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'] });
  pass(R, ['code', 'ux', 'ui', 'seo']);
  ev(R, 'review', 'failed', { axis: 'security', tokens: 52000, costUsd: 0.44, findings: [
    { severity: 'medium', file: 'app/api/subscribe/route.ts', issue: 'Email is not validated server-side.', route: 'build' },
    { severity: 'high', file: 'app/api/subscribe/route.ts', issue: 'Possible SSRF via webhook URL.', route: 'build', dismissed: 'No outbound request uses user input; the URL is a constant in lib/mail.ts:8.' }] });
  g(R);
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed');
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'], sha: '3b9e41d07c2a' });
  pass(R, ['code', 'security', 'ux', 'ui', 'seo']);
  g(R);
  d(R, { checks: 'pass', additions: 84, deletions: 6, files: ['components/Footer.tsx', 'app/api/subscribe/route.ts', 'components/Footer.test.tsx'] });
  ev(R, 'approve', 'merged');
  ev(R, 'approve', 'reverted', { pr: 'https://github.com/acme/shop/pull/93', reason: 'main CI: e2e footer test failed after merge' });

  R = 'acme/shop#46';
  intake(R, 'Epic: accounts', 46);
  ev(R, 'intake', 'split', { children: ['acme/shop#47', 'acme/shop#48'] });
  intake('acme/shop#47', 'Sign up with email', 47);
  intake('acme/shop#48', 'Password reset by email', 48);

  R = 'acme/shop#49';
  intake(R, 'Add Stripe checkout', 49, 'CONTRIBUTOR');
  ev(R, 'intake', 'passed', { summary: 'Clear, but touches payments.' });
  ev(R, 'spec', 'awaiting-approval', { spec: 'Checkout via existing payments module.', reasons: ['author association "CONTRIBUTOR" is not trusted', 'plans to touch sensitive paths: lib/payments/checkout.ts'] });

  R = 'acme/shop#44';
  intake(R, 'Let users log in with GitHub', 44);
  ev(R, 'intake', 'passed', { summary: 'Clear request from the owner.' });
  ev(R, 'spec', 'passed', { spec: 'OAuth via existing auth lib, GitHub provider only.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/91', branch: 'factory/issue-44' });
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui'], sha: '8d02f6ea51b7' });
  pass(R, ['code', 'security', 'ux', 'ui'], true); // reported: copied from each subagent's usage
  g(R);
  d(R, { checks: 'pass', additions: 140, deletions: 12, files: ['lib/auth/github.ts', 'package.json'] });
  ev(R, 'approve', 'escalated');

  R = 'acme/shop#45';
  intake(R, 'Fix typo on pricing page', 45);
  ev(R, 'intake', 'passed', { summary: 'Trivial, clearly worth it.' });
  ev(R, 'spec', 'passed', { spec: 'Correct "recieve" to "receive" in pricing copy.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/92', branch: 'factory/issue-45' });
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'] });
  pass(R, ['code', 'security']);

  // Custom and provider runners: what `skills set` would make F stamp on each event.
  R = 'acme/shop#50';
  const who: Record<string, Runner> = { spec: { use: 'skill', name: 'my-planner' }, build: { use: 'provider', harness: 'codex' }, verifier: { use: 'provider', harness: 'claude-code', name: 'pr-review-toolkit:code-reviewer' },
    code: { use: 'provider', harness: 'claude-code', name: 'code-review' }, ui: { use: 'skill', name: 'brand-review' }, a11y: { use: 'brief', path: '~/.claude/factory/briefs/a11y.md' } };
  const files = ['components/SizePicker.tsx', 'components/SizePicker.test.tsx'];
  const axes50 = axesFor(files, [{ axis: 'a11y', when: ['**/*.tsx'] }]);
  const review = (axis: string, text: string) => { const { status, payload } = reviewFromText(R, axis, text); ev(R, 'review', status, { ...payload, ...(who[axis] && { runner: who[axis] }) }); };
  const ok = (axis: string) => review(axis, JSON.stringify({ axis, verdict: 'passed', findings: [] }));
  intake(R, 'Add an accessible size picker to the product page', 50);
  ev(R, 'intake', 'passed', { summary: 'Clear and small: a radio-group picker replacing the select.' });
  ev(R, 'spec', 'passed', { spec: 'Radio-group size picker with keyboard support; reuses Button tokens.', runner: who.spec });
  ev(R, 'build', 'started', { runner: who.build });
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/94', branch: 'factory/issue-50', runner: who.build });
  ev(R, 'review', 'started', { axes: axes50 });
  axes50.filter((a) => a !== 'a11y').forEach(ok);
  review('a11y', 'Looks accessible to me. Ship it!'); // prose instead of the JSON contract
  g(R, { runner: who.verifier });
  ev(R, 'build', 'started', { runner: who.build });
  ev(R, 'build', 'passed', { runner: who.build });
  ev(R, 'review', 'started', { axes: axes50, sha: 'c47a19e2f305' });
  axes50.filter((a) => a !== 'a11y').forEach(ok);
  review('a11y', JSON.stringify({ axis: 'a11y', verdict: 'passed', findings: [{ severity: 'low', file: 'components/SizePicker.tsx', line: 31, issue: 'Focus ring uses the default outline instead of the focus token.', route: 'build' }] }));
  g(R, { runner: who.verifier });
  d(R, { checks: 'pass', additions: 96, deletions: 14, files });
  ev(R, 'approve', 'merged');

  // A billing rule: GitHub Actions can't run for acme/shop, so CI is skipped and F's own local checks stand in for it.
  // Only acme/shop's entry in skills.json is touched, in case FACTORY_DIR points at a real config.
  const cfg = readSkills(), rule = (value: unknown, reason: string, until?: string): Rule => ({ value, reason, setBy: 'acme', setAt: new Date(t).toISOString(), ...(until && { until }) });
  const shopRules: Record<string, Rule> = {
    ci: rule('skip', 'GitHub Actions billing is failing', dayOf(Date.now() + 30 * 864e5)),
    'checks.commands': rule(['pnpm test', 'pnpm lint'], 'stands in for CI while Actions is off', dayOf(Date.now() + 2 * 864e5)), // ending soon: shows the warning
    diffCap: rule(150, 'release freeze', dayOf(Date.now() - 864e5)), // expired: shows the warning
  };
  cfg['acme/shop'] = { ...cfg['acme/shop'], rules: shopRules };
  cfg['acme/shop'].guide = { build: 'use pnpm, never npm' };
  writeSkills(cfg);
  ev('acme/shop', 'rules', 'set', { key: 'ci', value: 'advisory', reason: 'Actions runners are flaky', setBy: 'acme' });
  for (const [key, { setAt: _s, ...x }] of Object.entries(shopRules)) ev('acme/shop', 'rules', 'set', { key, ...x });
  ev('acme/shop', 'rules', 'set', { key: 'guide.build', value: 'use pnpm, never npm', setBy: 'acme' });
  R = 'acme/shop#51';
  const sha = '5e1f0c2a9d3b', files51 = ['components/CartTotal.tsx', 'components/CartTotal.test.tsx'], axes51 = axesFor(files51);
  intake(R, 'Show a delivery estimate under the cart total', 51);
  ev(R, 'intake', 'passed', { summary: 'Small and clear: one line under the cart total.' });
  ev(R, 'spec', 'passed', { spec: 'Delivery estimate from the existing shipping helper; no new deps.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { localChecks: { state: 'pass', sha, commands: [{ cmd: 'pnpm test', exit: 0, ms: 48210 }, { cmd: 'pnpm lint', exit: 0, ms: 9120 }] } });
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/95', branch: 'factory/issue-51' });
  ev(R, 'review', 'started', { axes: axes51, sha });
  pass(R, axes51);
  g(R);
  d(R, { checks: 'skipped', additions: 58, deletions: 4, files: files51, rules: rules('acme/shop').policy });
  ev(R, 'approve', 'merged');
  // Deploy state, as a packages/ship connector records it: a preview per PR head, production for a merge.
  const dep = (run: string, env: string, state: string, status: string, sha: string, url: string, detail: string) => ev(run, 'ship', status, { connector: 'demo-host', kind: 'web-deploy', env, state, url, sha, at: new Date(t).toISOString(), detail, creator: 'deploy-bot' });
  dep('acme/shop#51', 'preview', 'ready', 'passed', sha, 'https://shop-pr-95.preview.example', 'Deployment has completed');
  dep('acme/shop#51', 'production', 'ready', 'passed', '9a7c41d2e0b8', 'https://shop.acme.dev', 'Deployment has completed');
  dep('acme/shop#45', 'preview', 'ready', 'passed', 'c0ffee12ab34', 'https://shop-pr-92.preview.example', 'Deployment has completed');
  dep('acme/shop#44', 'preview', 'error', 'failed', 'd15ea5e0b1a2', 'https://shop-pr-91.preview.example', 'Build failed: Type error in lib/auth/github.ts');
  demoTranscripts(read().filter((e) => e.sessionId === S.sessionId));
  return dashboard.render();
}
// Fake Claude Code transcripts for the demo session: an orchestrator message before each event, one subagent per review axis.
export function demoTranscripts(events: FactoryEvent[]) {
  io.projects = path.join(stateDir(), 'claude-projects');
  const dir = path.join(io.projects, '-work-shop'), subs = path.join(dir, 'demo-session', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const SIZE: Record<string, [number, number]> = { intake: [900, 5000], spec: [2600, 2500], build: [3200, 6000], review: [1200, 800], gate: [300, 200], approve: [700, 300] };
  let n = 0;
  const line = (ts: number, model: string, out: number, read: number, write: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: 'demo-session',
    message: { id: `msg_demo_${n++}`, model, usage: { input_tokens: 6, output_tokens: out, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } } } }) + '\n';
  let main = '', ctx = 30000;
  for (const e of events) {
    const at = Date.parse(e.ts), [out, write] = SIZE[e.stage]!; // the demo session's events: only these stages (ship has none)
    ctx += write;
    main += line(at - 40_000, 'claude-opus-5-5', out, ctx, write);
    if (e.stage === 'build' && e.status === 'passed') main += line(at - 20_000, 'claude-opus-5-5', out * 2, ctx, write);
    if (e.stage === 'review' && e.status === 'started') {
      for (const [j, axis] of [...e.axes!, 'verifier'].entries()) {
        const f = path.join(subs, `agent-${n}`), model = ['ui', 'seo', 'docs', 'verifier'].includes(axis) ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
        fs.writeFileSync(f + '.meta.json', JSON.stringify({ description: axis === 'verifier' ? 'verifier acme/shop' : `${axis} review acme/shop` }));
        fs.writeFileSync(f + '.jsonl', [1, 2, 3].map((k) => line(at + 5_000 + k * 9_000, model, 700 + k * 120 + j * 90, (11000 - j * 1500) * k, k === 1 ? 6000 : 1500)).join(''));
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'demo-session.jsonl'), main);
}
