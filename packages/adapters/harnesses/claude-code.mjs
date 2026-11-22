// Claude Code. Flags checked against claude 2.1.304: --version, `auth status` (JSON, exit 1 when logged out), -p headless flags.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Both streams: some CLIs print status to stderr. No shell, argv only, bounded by a timeout.
const run = (args) => {
  const r = spawnSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
  return { code: r.error ? -1 : r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// Built into Claude Code, no file on disk.
const TOOLS = [
  { name: 'code-review', tool: 'code-review', desc: 'Claude Code built-in /code-review: reviews the current diff. Replies in prose, so the adapter brief converts it.' },
  { name: 'security-review', tool: 'security-review', desc: 'Claude Code built-in /security-review: security review of the pending changes on the branch. Replies in prose.' },
];

// Pinned flags for a `claude -p` provider runner, so its behaviour never rides on -p's defaults.
// Never --bare: it would skip the `/x` skill being run and needs ANTHROPIC_API_KEY. Repo hooks and .mcp.json are cut by
// --setting-sources user and --strict-mcp-config instead. Read-only unless `write` (build): manual mode with prompts
// none denies anything outside the allowlist, where auto mode's classifier could approve other Bash. A schema adds the
// structured-output contract (reviews). Budget: unknown -> no flag, spent -> refuse.
function headlessArgs({ schema, budget, write = false } = {}) {
  const usd = budget == null ? null : Math.floor(Number(budget) * 100 + 1e-9) / 100; // whole cents, rounded down (1e-9: 0.29 * 100 is 28.999…)
  if (usd != null && !(usd > 0)) throw new Error(`no run budget left (${budget}); escalate instead of running`); // 0, negative and NaN alike
  return [
    '--output-format', 'json', '--setting-sources', 'user', '--strict-mcp-config',
    '--permission-mode', write ? 'auto' : 'manual', '--permission-prompts', 'none',
    ...(usd != null ? ['--max-budget-usd', String(usd)] : []),
    ...(schema ? ['--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema)] : []),
    ...(write ? [] : ['--allowedTools', 'Bash(git diff:*)', 'Bash(git log:*)', 'Read', 'Grep', 'Glob']), // variadic: keep last
  ];
}

export default {
  id: 'claude-code',
  label: 'Claude Code',
  install: 'curl -fsSL https://claude.ai/install.sh | bash',
  configDirs: ['.claude'],
  host: true, // runs the factory skill itself, so plugin agents found next to its skills run on it
  detect() {
    const r = run(['--version']);
    return { installed: r.code === 0, version: r.code === 0 ? (/\d+\.\d+\.\d+\S*/.exec(r.out)?.[0] || r.out.trim()) : null };
  },
  login() {
    const r = run(['auth', 'status']);
    let s = {};
    try { s = JSON.parse(r.out); } catch { /* older CLI or not installed */ }
    const ok = r.code === 0 && s.loggedIn !== false;
    return { ok, hint: ok ? s.authMethod || 'signed in' : 'claude auth login' };
  },
  headlessArgs, // F headless-args prints these; F names no harness
  headless: () => ({ cmd: 'claude', args: ['-p', '<prompt>', ...headlessArgs()], note: 'Read-only default; F headless-args <run> --write switches to auto mode for build, --review adds the review schema.' }),
  providerTools: () => TOOLS,
  notes() {
    const label = 'claude-cli:// links ("Open in Claude")', hint = 'Run claude and send one message in an interactive session; that registers the link handler.';
    if (process.platform !== 'darwin') return [{ label, ok: null, hint }];
    const ok = fs.existsSync(path.join(os.homedir(), 'Applications', 'Claude Code URL Handler.app'));
    return [{ label, ok, hint: ok ? 'handler registered' : hint }];
  },
  current: () => process.env.CLAUDE_CODE_SESSION_ID || null, // set by Claude Code; lets the UI link back to the driving session
  // Reads branch names and file times only, never prompt text.
  sessions(repoPath) {
    const root = path.join(os.homedir(), '.claude', 'projects'), out = [];
    const prefix = repoPath.replace(/[^a-zA-Z0-9]/g, '-'); // Claude Code's project-folder naming
    for (const d of ls(root).filter((d) => d === prefix || d.startsWith(prefix + '-'))) {
      for (const f of ls(path.join(root, d)).filter((f) => f.endsWith('.jsonl'))) {
        const file = path.join(root, d, f), text = fs.readFileSync(file, 'utf8'), last = fs.statSync(file).mtime.toISOString();
        const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]; // first cwd = where the session was started
        for (const branch of new Set([...text.matchAll(/"gitBranch":"([^"]*)"/g)].map((m) => m[1]))) out.push({ branch, id: f.slice(0, -6), cwd, last });
      }
    }
    return out;
  },
};
