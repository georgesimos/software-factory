// Spawning without a shell on every OS (docs/plans/cross-platform-audit.md §1). On Windows execFile finds only `x.exe`,
// and since CVE-2024-27980 a `.cmd`/`.bat` shim (npm, pnpm, npx, npm-installed CLIs) throws EINVAL without a shell.
// So: resolve through PATH and PATHEXT; run an .exe directly; run a shim through `cmd.exe /d /s /c` only when every
// argument is plain (no cmd.exe escaping is attempted: a mistake there is command injection); never `shell: true`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { ExecFileSyncOptions, SpawnSyncOptions } from 'node:child_process';

type Env = Record<string, string | undefined>;
export interface Resolve { platform?: NodeJS.Platform; env?: Env; isFile?: (p: string) => boolean }
export interface Command { file: string; args: string[]; windowsVerbatimArguments?: boolean }

// What cmd.exe treats as plain text: no & | < > ^ " % ! ( ) or whitespace. Empty arguments need quotes, so they fail too.
const PLAIN = /^[\w\-.,:/\\=@+~]+$/;
const envGet = (env: Env, key: string) => env[Object.keys(env).find((k) => k.toUpperCase() === key) ?? key];
const isFileSync = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function findOnPath(cmd: string, env: Env, isFile: (p: string) => boolean): string | undefined {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()); // NTFS ignores case
  const names = exts.some((e) => cmd.toLowerCase().endsWith(e)) ? [cmd, ...exts.map((e) => cmd + e)] : exts.map((e) => cmd + e);
  const dirs = /[\\/]/.test(cmd) ? [''] : (envGet(env, 'PATH') || '').split(';').filter(Boolean);
  for (const d of dirs) for (const n of names) { const p = d ? path.win32.join(d, n) : n; if (isFile(p)) return p; }
  return undefined;
}

// The file and argv to hand to execFile/spawn for `cmd args` on this platform.
export function command(cmd: string, args: string[] = [], { platform = process.platform, env = process.env, isFile = isFileSync }: Resolve = {}): Command {
  if (platform !== 'win32') return { file: cmd, args };
  const file = findOnPath(cmd, env, isFile);
  if (!file) return { file: cmd, args }; // not found: let the spawn fail with ENOENT, as on POSIX ("not installed")
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args };
  const bad = args.find((a) => !PLAIN.test(a));
  if (bad !== undefined || /["%]/.test(file)) {
    throw new Error(`${path.win32.basename(file)} is a .cmd shim, and ${JSON.stringify(bad ?? file)} would need cmd.exe quoting; install a native ${cmd}.exe or run this step yourself`);
  }
  // /s strips the outer quotes, leaving "file" args; verbatim so Node adds no quoting of its own.
  return { file: envGet(env, 'COMSPEC') || 'cmd.exe', args: ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], windowsVerbatimArguments: true };
}

export function exec(cmd: string, args: string[] = [], options: ExecFileSyncOptions = {}) {
  const c = command(cmd, args);
  return execFileSync(c.file, c.args, { ...options, ...(c.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

export function run(cmd: string, args: string[] = [], options: SpawnSyncOptions = {}) {
  let c: Command;
  try { c = command(cmd, args); } catch (error) { return { status: null, stdout: '', stderr: '', error: error as Error }; }
  return spawnSync(c.file, c.args, { ...options, ...(c.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}
