// Claude Code. Flags checked against claude 2.1.304: --version, `auth status` (JSON, exit 1 when logged out), -p headless flags.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// On Windows only an .exe found on PATH: a bare name would be looked up in the current folder (maybe an untrusted clone)
// first. Bare spawns only ever found .com/.exe there, so nothing else is lost. Not found: reported as not installed.
const which = (name) => process.platform !== 'win32' ? name : (process.env.PATH || '').split(';').map((d) => d && path.win32.join(d, `${name}.exe`)).find((f) => f && fs.existsSync(f));
// Both streams: some CLIs print status to stderr. No shell, argv only, bounded by a timeout.
const run = (args) => {
  const file = which('claude');
  const r = file ? spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }) : { error: true };
  return { code: r.error ? -1 : r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// Built into Claude Code, no file on disk.
const TOOLS = [
  { name: 'code-review', tool: 'code-review', desc: 'Claude Code built-in /code-review: reviews the current diff. Replies in prose, so the adapter brief converts it.' },
  { name: 'security-review', tool: 'security-review', desc: 'Claude Code built-in /security-review: security review of the pending changes on the branch. Replies in prose.' },
];

// Aliases only: the Agent tool's `model` takes an alias, not an id. minVersion: older CLIs don't know the model.
const MODELS = [
  { id: 'claude-fable-5-2', alias: 'fable', label: 'Fable 5.2', minVersion: '2.1.321' },
  { id: 'claude-opus-5-5', alias: 'opus', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', alias: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', alias: 'haiku', label: 'Haiku 5.5' },
];

// Pinned flags for a `claude -p` provider runner, so its behaviour never rides on -p's defaults.
// Never --bare: it would skip the `/x` skill being run and needs ANTHROPIC_API_KEY. Repo hooks and .mcp.json are cut by
// --setting-sources user and --strict-mcp-config instead. Read-only unless `write` (build): manual mode with prompts
// none denies anything outside the allowlist, where auto mode's classifier could approve other Bash. A schema adds the
// structured-output contract (reviews); model, effort and fallback come from the step's runner. Budget: unknown -> no flag, spent -> refuse.
const READ_ONLY_TOOLS = ['Bash(git diff:*)', 'Bash(git log:*)', 'Read', 'Grep', 'Glob'];
function usdOf(budget) {
  const usd = budget == null ? null : Math.floor(Number(budget) * 100 + 1e-9) / 100; // whole cents, rounded down (1e-9: 0.29 * 100 is 28.999…)
  if (usd != null && !(usd > 0)) throw new Error(`no run budget left (${budget}); escalate instead of running`); // 0, negative and NaN alike
  return usd;
}
function headlessArgs({ schema, budget, write = false, stream = false, model, effort, fallback } = {}) {
  const usd = usdOf(budget);
  return [
    ...(stream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']), '--setting-sources', 'user', '--strict-mcp-config',
    '--permission-mode', write ? 'auto' : 'manual', '--permission-prompts', 'none',
    ...(usd != null ? ['--max-budget-usd', String(usd)] : []),
    ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
    ...(fallback?.length ? ['--fallback-model', fallback.join(',')] : []), // `claude --help`: a comma-separated list, tried in order
    ...(schema ? ['--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema)] : []),
    ...(write ? [] : ['--allowedTools', ...READ_ONLY_TOOLS]), // variadic: keep last
  ];
}

export default {
  id: 'claude-code',
  label: 'Claude Code',
  install: process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
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
  models: () => MODELS,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  headlessArgs, // F headless-args prints these; F names no harness
  headless: () => ({ cmd: 'claude', args: ['-p', '<prompt>', ...headlessArgs()], note: 'Read-only default; F headless-args <run> --write switches to auto mode for build, --review adds the review schema.' }),
  // launch() only says what to run; packages/adapters/sessions.mjs runs it. headless: NDJSON events on stdout (stream-json
  // needs --verbose). terminal: an interactive claude for a pseudo-terminal host (node-pty, H1 part 2).
  modes: ['headless', 'terminal', 'sdk'],
  launch({ mode, prompt, resume, budget, write = false }) {
    const res = resume ? ['--resume', resume] : [];
    if (mode === 'headless') {
      if (!prompt) throw new Error('a headless launch needs a prompt');
      return { cmd: 'claude', args: [...res, '-p', ...headlessArgs({ budget, write, stream: true })], stdin: prompt }; // the prompt on stdin: npm's claude.cmd can't take it as an argument
    }
    // terminal: a person at the keyboard, so no budget or permission flags; launchSession() never starts one for a factory run
    if (mode === 'terminal') { // a person types the prompt: as an argument, a .cmd shim (Windows) could not pass a space
      if (prompt) throw new Error('terminal mode takes no prompt: type it in the session');
      return { cmd: 'claude', args: res };
    }
    if (mode === 'sdk') { // the Agent SDK's query(): the same pinned policy as headlessArgs, as SDK options (checked against 0.3.330)
      if (!prompt) throw new Error('an sdk launch needs a prompt');
      const usd = usdOf(budget);
      return { module: '@anthropic-ai/claude-agent-sdk', prompt, options: { ...(resume && { resume }), settingSources: ['user'], strictMcpConfig: true,
        permissionMode: write ? 'auto' : 'default', ...(usd != null && { maxBudgetUsd: usd }), ...(write ? {} : { allowedTools: READ_ONLY_TOOLS }),
        permissionPrompts: 'none' } }; // as --permission-mode manual|auto --permission-prompts none: what would prompt is denied, never waits
    }
    throw new Error(`claude-code has no ${mode} mode`);
  },
  // The desktop app's own link for one of its sessions. Observed, not documented (ADR §5): best effort; callers fall back
  // to `claude --resume <id>` in a terminal when this returns null.
  openDesktop: (id) => (/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(id)) ? `claude://claude.ai/epitaxy/${id}` : null),
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
