import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { derive } from './derive.ts';
import { command, exec, type Resolve } from './platform.ts';
import { io, read } from './log.ts';
import { ls } from './workspace.ts';

const evalArgs = (run: string) => ['-p', `/software-factory ${run} --dry-run --intake-only`, '--allowedTools', 'Bash(node:*)', 'Read', 'Grep', 'Glob'];
// Throws when the claude found is a .cmd shim these arguments can't pass through (Windows), instead of every fixture scoring "no-outcome".
export const evalCommand = (run: string, resolve?: Resolve) => command('claude', evalArgs(run), resolve);

// Runs intake on each golden fixture with a headless Claude session (costs tokens; user-triggered) and scores the outcome.
export function evals(only?: string) {
  const dir = path.join(import.meta.dirname, '..', '..', 'factory', 'evals', 'golden');
  const ids = ls(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((n) => !only || n === only).sort((a, b) => Number(a) - Number(b)); // numeric names: 2 before 10
  const results: { fixture: string; expect: unknown; got: string; ok: boolean }[] = [];
  if (ids.length) evalCommand(`eval/golden#${ids[0]}`); // no usable claude: throw now, before any temp dir (every run has the same shape)
  for (const n of ids) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-eval-'));
    const run = `eval/golden#${n}`;
    try {
      exec('claude', evalArgs(run),
        { env: { ...process.env, FACTORY_DIR: tmp, FACTORY_FIXTURES: dir }, stdio: 'ignore', timeout: 600_000 });
    } catch { /* scored below from whatever was recorded */ }
    const prevDir = io.dir; io.dir = tmp;
    const r = derive(read())[run];
    io.dir = prevDir;
    const last = r?.events.filter((e) => e.stage === 'intake' || e.status === 'split').pop()?.status;
    const got = ({ passed: 'pass', 'needs-info': 'needs-info', rejected: 'reject', split: 'split' } as Record<string, string>)[last ?? ''] || 'no-outcome';
    results.push({ fixture: n, expect: fx.expect, got, ok: got === fx.expect });
  }
  return { score: `${results.filter((r) => r.ok).length}/${results.length}`, results };
}
