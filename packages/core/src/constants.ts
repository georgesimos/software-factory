import { harnesses } from '../../adapters/harnesses/index.ts';
import type { Finding } from './types.ts';

export const CAP = 3;          // max build iterations before escalating
export const MAX_DIFF = 300;   // added + deleted lines allowed for auto-merge
export const COST_CAP = 5;     // USD per run; over it, the run stops looping and escalates
export const TOKEN_CAP = 3_000_000; // same, for runs that record tokens but not dollars (cache reads not counted when known)
export const PROJECT_BUDGET_USD = 50; // per idea-to-app project, over all its issue runs; rule project.budgetUsd can only lower it
export const MAX_ISSUES_PER_SESSION = 10; // issues one `F loop` session picks before it stops; rule project.maxIssuesPerSession can only lower it
// $ per million tokens: [input, output, cache read, cache write 5m, cache write 1h]. Fast mode bills 2x.
// shortcut: hand-copied from Anthropic's pricing pages in 2026-11 (Fable 5.2 input/output checked against Claude Code's own cost-state
// lines; its cache read is 0.025x and its writes 1.25x / 2x, per docs/research/model-routing.md §6.1); keep them current. Unknown models get no cost, only tokens.
export const PRICES: Record<string, number[]> = {
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5, 4],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125, 0.2], // shortcut: the prompts-up-to-100K tier; longer prompts bill 5x
  'claude-fable-5-2': [8, 40, 0.2, 10, 16],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-7': [5, 25, 0.5, 6.25, 10], 'claude-opus-4-6': [5, 25, 0.5, 6.25, 10], 'claude-opus-4-5': [5, 25, 0.5, 6.25, 10],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6], 'claude-sonnet-4-5': [3, 15, 0.3, 3.75, 6],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
};
// t = [input, output, cacheRead, cacheWrite5m, cacheWrite1h]; null when the model has no price.
export const costOf = (model: unknown, t: number[], fast?: unknown): number | null => {
  const p = PRICES[String(model || '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')];
  return p ? (t.reduce((s, n, i) => s + n * (p[i] as number), 0) / 1e6) * (fast ? 2 : 1) : null;
};
// Value lists are readonly unknown[]: their .includes() tests values read from the log or GitHub, which may be anything.
export const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
export const TRUSTED: readonly unknown[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];
// A rule or note whose author is the OS user, not a verified GitHub login (rules.ts whoami), and how it is shown.
export const isLocal = (x: { via?: unknown } | null | undefined) => x?.via === 'local';
export const byText = (x: { setBy?: unknown; by?: unknown; via?: unknown }) => `${x.setBy ?? x.by}${isLocal(x) ? ' (local, unverified)' : ''}`;
export const OUTCOMES: readonly unknown[] = ['rejected', 'needs-info', 'merged', 'escalated', 'closed', 'awaiting-approval', 'split'];
export const TERMINAL: readonly unknown[] = ['rejected', 'merged', 'escalated', 'closed', 'split']; // needs-info / awaiting-approval resume later
export const STAGES: readonly unknown[] = ['intake', 'spec', 'build', 'review', 'gate', 'approve', 'ship']; // ship: deploy observations, recorded only by packages/ship's track()
export const STATUSES: readonly unknown[] = ['started', 'passed', 'failed', 'decided', 'reverted', ...OUTCOMES];
export const BLOCKING: readonly unknown[] = ['high', 'medium'];
export const SENSITIVE = /(^|\/)(auth|login|session|oauth|payments?|billing|money|migrations?)(\/|\.|$)|^\.github\/workflows\/|(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock))$|(^|\/)\.env|(^|\/)\.(claude|codex|factory)\/|(^|\/)\.mcp\.json$/i; // .factory/: local items (local-first D3), never in a change. .claude/** (settings, hooks, skills, agents), .codex/ and .mcp.json: `claude -p` in the worktree runs repo hooks and MCP servers with no trust prompt
// A harness adapter can name its own repo config folder (configDirs); that only ever adds sensitive paths.
export const sensitive = (p: string) => SENSITIVE.test(p) || harnesses.some((h) => (h.configDirs || []).some((d) => ('/' + p).includes('/' + d + '/')));
export const UI = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i;
export const SEO = /(^|\/)(page|layout|head|metadata|sitemap|robots|opengraph-image)\.[a-z]+$|(^|\/)pages\/|\.html$/i;
export const DOCS = /\.mdx?$|(^|\/)\.env\.example$|(^|\/)(app\/api|pages\/api|routes|cli|bin)\//i; // docs, env and public API surface
export const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|swift|php|cs|vue|svelte)$/i;
export const TEST = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?|e2e|spec)\//i;
export const SEVERITIES: readonly unknown[] = ['high', 'medium', 'low'];
export const REVIEW_KEYS = ['axis', 'verdict', 'findings', 'costUsd', 'tokens', 'usage', 'model'];
export const VERIFIER_KEYS = ['role', 'costUsd', 'tokens', 'usage', 'model'];
export const FINDING_KEYS = ['severity', 'file', 'line', 'issue', 'route', 'dismissed'];
export const blocking = (f: Finding) => BLOCKING.includes(f.severity) && !f.dismissed; // a verifier-dismissed finding never blocks
export const isSensitive = (p: string) => SENSITIVE.test(p);
