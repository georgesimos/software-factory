// Template for a new AI harness. Copy to harnesses/<id>.mjs (the id must equal the file name), fill in, and add
// test/bin/<binary> as its stub. Skipped by the registry because the name starts with "_". See HARNESSES.md.
// Import only node: builtins, never factory.mjs. detect() and login() must never throw.
import { spawnSync } from 'node:child_process';

const BIN = 'my-agent';
// Both streams: some CLIs print status to stderr. No shell, argv only, bounded by a timeout.
const run = (args) => {
  const r = spawnSync(BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
  return { code: r.error ? -1 : r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}` };
};

export default {
  id: 'my-agent',                         // = file name; what skills.json stores as {"use":"provider","harness":"my-agent"}
  label: 'My Agent',                      // shown in the wizard, the catalog and session chips
  install: 'npm install -g my-agent',     // the fix command when it isn't installed
  configDirs: ['.my-agent'],              // optional: repo folders holding this agent's config; a PR touching them never auto-merges
  detect() {                              // required → {installed, version}
    const r = run(['--version']);
    return { installed: r.code === 0, version: r.code === 0 ? (/\d+\.\d+\.\d+\S*/.exec(r.out)?.[0] || r.out.trim()) : null };
  },
  login() {                               // required → {ok, hint}; hint is the login command when !ok
    const r = run(['auth', 'status']);
    return r.code === 0 ? { ok: true, hint: 'signed in' } : { ok: false, hint: `${BIN} login` };
  },
  // Everything below is optional: leave out what the harness can't do.
  headless: () => ({ cmd: BIN, args: ['run', '--json', '<prompt>'], note: 'How the orchestrator runs it unattended.' }),
  providerTools: () => [{ name: 'my-agent run', desc: 'Runs My Agent headless in the run worktree.' }], // add tool: '<sub-name>' for {"name": …}
  sessions: (repoPath, remoteUrl) => [],  // → [{branch, id, cwd, last}] from the agent's local logs; branch names and times only, never prompts
  notes: () => [],                        // → [{label, ok: true|false|null, hint}] extra setup checks for the wizard
  current: () => null,                    // → the session id when F runs inside this agent (from its env), else null
  // Reserved for per-step model selection (not read yet): the models and aliases a runner on this harness can pick.
  // models: () => [{ id: 'my-model-1', alias: 'fast', label: 'My Model 1' }],
};
