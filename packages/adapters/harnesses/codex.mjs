// Codex. Flags checked against codex-cli 0.141.0: --version, `login status` (exit 1 "Not logged in"), exec -C/-s/--output-schema/-o.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// What to spawn for `name args`. On Windows only a file found on PATH (quoted entries unquoted), never the bare name, which
// Windows looks up in the current folder (maybe an untrusted clone) first: an .exe directly, an npm .cmd shim through
// cmd.exe /d /s /c like sessions do, only with plain args (no cmd.exe quoting is attempted). The shim runs a bare `node`, which
// cmd.exe would look for in the current folder first: run it from the shim's own folder with that lookup off. Relative PATH
// entries never count. null: not installed, or not runnable safely. Kept in this file: a harness is one file with node: builtins only.
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const PLAIN = /^[\w\-.,:/\\=@+~]+$/; // what cmd.exe passes as is: core/src/platform.ts command()'s rule
export function spawnFor(name, args, platform = process.platform, env = process.env, exists = isFile) {
  if (platform !== 'win32') return [name, args, {}];
  for (const d of String(env.PATH ?? env.Path ?? '').split(';').map((x) => x.trim().replace(/^"(.*)"$/, '$1')).filter((x) => path.win32.isAbsolute(x))) {
    for (const ext of ['.exe', '.cmd']) {
      const f = path.win32.join(d, name + ext);
      if (!exists(f)) continue;
      if (ext === '.exe') return [f, args, {}];
      if (/["%]/.test(f) || !args.every((a) => PLAIN.test(a))) return null; // would need cmd.exe quoting
      return [env.ComSpec || env.COMSPEC || path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${f}" ${args.join(' ')}"`],
        { windowsVerbatimArguments: true, cwd: d, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } }];
    }
  }
  return null;
}
// Both streams: some CLIs print status to stderr. No shell, argv only, bounded by a timeout.
const run = (args) => {
  const s = spawnFor('codex', args);
  const r = s ? spawnSync(s[0], s[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000, ...s[2] }) : { error: true };
  return { code: r.error ? -1 : r.status ?? -1, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const slug = (url) => /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url || '')?.[1].toLowerCase(); // owner/repo from any remote URL form

const adapter = {
  id: 'codex',
  label: 'Codex',
  install: 'npm install -g @openai/codex',
  configDirs: ['.codex'],
  detect() {
    const r = run(['--version']);
    return { installed: r.code === 0, version: r.code === 0 ? (/\d+\.\d+\.\d+\S*/.exec(r.out)?.[0] || r.out.trim()) : null };
  },
  login() {
    const r = run(['login', 'status']);
    const ok = r.code === 0 && /logged in/i.test(r.out) && !/not logged in/i.test(r.out);
    return { ok, hint: ok ? r.out.trim().split('\n').pop().replace(/^logged in\s*/i, '') || 'signed in' : 'codex login' };
  },
  headless: () => ({ cmd: 'codex', args: ['exec', '-C', '<worktree>', '-s', 'read-only', '--output-schema', '<review.schema.json>', '-o', '<out.json>', '<prompt>'],
    note: 'Build uses -s workspace-write. Never pass --dangerously-bypass-approvals-and-sandbox.' }),
  providerTools: () => (adapter.detect().installed ? [
    { name: 'codex exec', desc: 'Runs Codex headless in the run worktree with the step\'s brief; reviews return the JSON contract via --output-schema.' },
    { name: 'codex review', tool: 'review', desc: 'Codex\'s own reviewer against the base branch. Replies in prose, so the adapter brief converts it.' },
  ] : []),
  // The first line of each session file is session_meta with the git branch and remote; nothing else is read.
  sessions(repoPath, remoteUrl) {
    const root = path.join(os.homedir(), '.codex', 'sessions'), want = slug(remoteUrl), out = [];
    let files = [];
    try { files = fs.readdirSync(root, { recursive: true }); } catch { return out; }
    for (const f of files.map(String).filter((f) => f.endsWith('.jsonl'))) {
      const file = path.join(root, f), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(8192);
      const first = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8').split('\n')[0];
      fs.closeSync(fd);
      try {
        const meta = JSON.parse(first).payload, g = meta?.git;
        if (g?.branch && want && slug(g.repository_url) === want) out.push({ branch: g.branch, id: meta.id, cwd: meta.cwd, last: fs.statSync(file).mtime.toISOString() });
      } catch { /* first line cut off or not session_meta: skip */ }
    }
    return out;
  },
};
export default adapter;
