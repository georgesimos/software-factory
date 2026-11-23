// Spawning without a shell on every OS (docs/plans/cross-platform-audit.md §1). On Windows execFile finds only `x.exe`,
// and since CVE-2024-27980 a `.cmd`/`.bat` shim (npm, pnpm, npx, npm-installed CLIs) throws EINVAL without a shell.
// So: resolve through PATH and PATHEXT; run an .exe directly; run a shim through `cmd.exe /d /s /c` only when every
// argument is plain (no cmd.exe escaping is attempted: a mistake there is command injection); never `shell: true`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ExecFileSyncOptions, SpawnSyncOptions } from 'node:child_process';

type Env = Record<string, string | undefined>;
export interface Resolve { platform?: NodeJS.Platform; env?: Env; isFile?: (p: string) => boolean }
export interface Command { file: string; args: string[]; windowsVerbatimArguments?: boolean }

// What cmd.exe treats as plain text: no & | < > ^ " % ! ( ) or whitespace. Empty arguments need quotes, so they fail too.
const PLAIN = /^[\w\-.,:/\\=@+~]+$/;
const envGet = (env: Env, key: string) => env[Object.keys(env).find((k) => k.toUpperCase() === key) ?? key];
const isFileSync = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function findOnPath(cmd: string, env: Env, isFile: (p: string) => boolean, skip?: RegExp): string | undefined {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()); // NTFS ignores case
  const names = exts.some((e) => cmd.toLowerCase().endsWith(e)) ? [cmd, ...exts.map((e) => cmd + e)] : exts.map((e) => cmd + e);
  const dirs = /[\\/]/.test(cmd) ? [''] : (envGet(env, 'PATH') || '').split(';').filter((d) => d && !skip?.test(d));
  for (const d of dirs) for (const n of names) { const p = d ? path.win32.join(d, n) : n; if (isFile(p)) return p; }
  return undefined;
}

// The file and argv to hand to execFile/spawn for `cmd args` on this platform.
export function command(cmd: string, args: string[] = [], { platform = process.platform, env = process.env, isFile = isFileSync }: Resolve = {}): Command {
  if (/\.[cm]?js$/i.test(cmd)) return { file: process.execPath, args: [cmd, ...args] }; // a script override (FACTORY_GH=stub.mjs) runs under this node: no shebang on Windows
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

// The POSIX shell for `checks.commands` (written for sh). On Windows that is Git Bash, the shell Claude Code uses:
// CLAUDE_CODE_GIT_BASH_PATH; else Git's bin\bash.exe one or two levels above git.exe (…\Git\cmd\git.exe,
// …\Git\mingw64\bin\git.exe); else %ProgramFiles%\Git; else bash.exe on PATH, but not WSL's launcher. Never cmd.exe.
export function posixShell({ platform = process.platform, env = process.env, isFile = isFileSync }: Resolve = {}): string {
  if (platform !== 'win32') return '/bin/sh';
  const set = envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  const git = findOnPath('git.exe', env, isFile), up = (n: number) => git && path.win32.join(path.win32.dirname(git), ...Array(n).fill('..'), 'bin', 'bash.exe');
  const pf = envGet(env, 'PROGRAMFILES'), onPath = findOnPath('bash.exe', env, isFile, /\\(System32|WindowsApps)\\?$/i); // those bash.exe are WSL's
  const found = [set, up(1), up(2), pf && path.win32.join(pf, 'Git', 'bin', 'bash.exe'), onPath].find((p) => p && isFile(p));
  if (!found) throw new Error('checks.commands need a POSIX shell: install Git for Windows (Git Bash), or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe');
  return found;
}

// `F open`: the OS opener for an https: or claude-cli: URL, or a file: URL of an .html page (the dashboard). Any other
// file: target could be a program (.exe, .bat, .app, .command) that the opener would run. No shell: on Windows
// explorer.exe hands the URL to its registered handler, so an `&` in a URL is never a cmd.exe operator.
export function opener(target: string, platform: NodeJS.Platform = process.platform): Command {
  let url: URL;
  try { url = new URL(target); } catch { throw new Error(`not a URL: ${target}`); }
  const desktop = /^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target); // one session link, nothing else under claude:
  if (!desktop && !['https:', 'file:', 'claude-cli:'].includes(url.protocol)) throw new Error(`refusing to open ${url.protocol} URLs; only https:, file: and claude-cli:`);
  if (url.protocol === 'file:' && !/\.html?$/i.test(url.pathname)) throw new Error(`refusing to open ${url.pathname}: file: URLs must be .html pages`);
  const href = url.href;
  if (platform === 'darwin') return { file: 'open', args: [href] };
  if (platform === 'win32') return { file: 'explorer.exe', args: [href] };
  return { file: 'xdg-open', args: [href] };
}
export function open(target: string, { platform = process.platform, env = process.env, isFile = isFileSync }: Resolve = {}) {
  const c = opener(target, platform);
  const found = platform === 'win32' ? findOnPath(c.file, env, isFile) || isFile(path.win32.join(envGet(env, 'SYSTEMROOT') || 'C:\\Windows', c.file))
    : (envGet(env, 'PATH') || '').split(':').some((d) => d && isFile(path.join(d, c.file)));
  if (!found) throw new Error(`no ${c.file} here to open ${target}; open it yourself`);
  spawn(c.file, c.args, { detached: true, stdio: 'ignore' }).on('error', () => { /* reported below by the caller's hint */ }).unref();
  return target;
}

// `F install-skill`: link ~/.claude/skills/software-factory to this checkout's packages/factory. A junction on Windows
// (no admin or Developer Mode needed), a symlink elsewhere. Never a copy: factory.mjs imports ../core by relative path.
export function linkSkill(target: string, link: string, platform: NodeJS.Platform = process.platform) {
  let current: string | undefined;
  try { current = fs.realpathSync(link); } catch { /* nothing there yet */ }
  if (current === fs.realpathSync(target)) return { link, target, created: false };
  if (current !== undefined || fs.existsSync(link)) throw new Error(`${link} already exists and is not a link to ${target}; move it aside first`);
  try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* no dangling link */ }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, platform === 'win32' ? 'junction' : 'dir');
  return { link, target, created: true };
}

// `F install-cli`: a `factory` command in a user bin dir, never one that needs admin. factory.mjs is not executable in
// git (100644), so a shim runs it with the `node` on PATH (an old one prints the upgrade message). Windows gets a .cmd for
// cmd.exe and PowerShell and an extensionless sh shim for Git Bash, which ignores PATHEXT. MARK makes a re-run idempotent
// and keeps it off a `factory` someone else wrote. shortcut: a plugin update moves the cache path; the shim then says to re-run.
const MARK = 'software-factory install-cli';
export function cliShims(entry: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const posix = platform === 'win32' ? entry.replace(/\\/g, '/') : entry, q = `'${posix.replace(/'/g, `'\\''`)}'`;
  const sh = `#!/bin/sh\n# ${MARK}\n[ -f ${q} ] || { echo "factory: ${posix.replace(/["$`\\]/g, '\\$&')} is gone (a plugin update moves it); run F install-cli again" >&2; exit 1; }\nexec node ${q} "$@"\n`;
  if (platform !== 'win32') return { factory: sh };
  if (/["%]/.test(entry)) throw new Error(`${entry} has a " or %, which a .cmd shim cannot hold; run node "${entry}" instead`);
  const cmd = ['@echo off', `rem ${MARK}`, `if not exist "${entry}" (echo factory: its install moved, which a plugin update does; run F install-cli again 1>&2& exit /b 1)`, `node "${entry}" %*`];
  return { factory: sh, 'factory.cmd': `${cmd.join('\r\n')}\r\n` };
}

// The Path a new cmd.exe or PowerShell starts with: the registry user and machine values, with %VARS% expanded. Not this
// process's PATH: Git Bash, where Claude Code runs F on Windows, adds ~/bin and other folders Windows itself never sees.
// reg.exe by full path: a bare 'reg' may resolve from the current folder first, and F can run inside an untrusted clone.
export function windowsPath(env: Env = process.env, run: (file: string, args: string[], o: object) => string = execFileSync as never) {
  const reg = path.win32.join(envGet(env, 'SYSTEMROOT') || 'C:\\Windows', 'System32', 'reg.exe');
  const read = (key: string) => { try { return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(run(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))?.[1].trim() ?? ''; } catch { return ''; } };
  return [read('HKCU\\Environment'), read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')].join(';')
    .replace(/%([^%;]+)%/g, (m, v) => envGet(env, v) ?? m);
}

// Where install-cli writes: whichever of ~/.local/bin and ~/bin comes first on PATH, else ~/.local/bin (not yet on PATH).
// PATH entries are judged as absolute paths only, with a leading ~ meaning home; relative ones never count.
export function cliDir(home: string, pathList: string, platform: NodeJS.Platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (d: string) => { const n = p.normalize(d).replace(/[\\/]+$/, ''); return platform === 'win32' ? n.toLowerCase() : n; };
  const dirs = [p.join(home, '.local', 'bin'), p.join(home, 'bin')];
  for (const e of pathList.split(platform === 'win32' ? ';' : ':')) {
    const abs = /^~(?=[\\/]|$)/.test(e) ? p.join(home, e.slice(1)) : e;
    const hit = p.isAbsolute(abs) && dirs.find((d) => norm(d) === norm(abs));
    if (hit) return { dir: hit, onPath: true };
  }
  return { dir: dirs[0], onPath: false };
}

export function installCli(entry: string, { home, platform = process.platform, env = process.env, pathList }: { home: string; platform?: NodeJS.Platform; env?: Env; pathList?: string }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const { dir, onPath } = cliDir(home, pathList ?? (platform === 'win32' ? windowsPath(env) : envGet(env, 'PATH') || ''), platform);
  const shims = cliShims(entry, platform);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(shims)) { // check every file before writing any; never write through a link
    const f = p.join(dir, name), st = fs.lstatSync(f, { throwIfNoEntry: false });
    if (st && (!st.isFile() || !fs.readFileSync(f, 'utf8').includes(MARK))) throw new Error(`${f} already exists and was not written by install-cli; move it aside first`);
  }
  for (const [name, text] of Object.entries(shims)) fs.writeFileSync(p.join(dir, name), text, { mode: 0o755 });
  if (platform !== 'win32') fs.chmodSync(p.join(dir, 'factory'), 0o755); // mode is ignored when the file already exists
  const fish = /(^|\/)fish$/.test(envGet(env, 'SHELL') || '');
  const addToPath = onPath ? undefined : platform === 'win32'
    ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${dir.replace(/'/g, "''")}', 'User')   # PowerShell, then open a new terminal`
    : fish ? `fish_add_path '${dir.replace(/['\\]/g, '\\$&')}'   # run once in fish`
    : `export PATH="${dir.replace(/["$`\\]/g, '\\$&')}:$PATH"   # add this line to your shell profile (~/.zshrc, ~/.bashrc), then open a new terminal`;
  return { dir, files: Object.keys(shims).map((n) => p.join(dir, n)), entry, ...(addToPath ? { onPath: false, addToPath } : { onPath: true }) };
}
