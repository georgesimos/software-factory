// Spawning without a shell on every OS (docs/plans/cross-platform-audit.md §1). On Windows execFile finds only `x.exe`,
// and since CVE-2024-27980 a `.cmd`/`.bat` shim (npm, pnpm, npx, npm-installed CLIs) throws EINVAL without a shell.
// So: resolve through PATH and PATHEXT; run an .exe directly; run a shim through `cmd.exe /d /s /c` only when every
// argument is plain (no cmd.exe escaping is attempted: a mistake there is command injection); never `shell: true`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ExecFileSyncOptions, ExecFileSyncOptionsWithStringEncoding, SpawnSyncOptions } from 'node:child_process';

type Env = Record<string, string | undefined>;
export interface Resolve { platform?: NodeJS.Platform; env?: Env; isFile?: (p: string) => boolean }
// env: added to the spawn's env (callers merge it over their own).
export interface Command { file: string; args: string[]; windowsVerbatimArguments?: boolean; env?: Env }

// What cmd.exe treats as plain text: no & | < > ^ " % ! ( ) or whitespace. Empty arguments need quotes, so they fail too.
const PLAIN = /^[\w\-.,:/\\=@+~]+$/;
const envGet = (env: Env, key: string) => env[Object.keys(env).find((k) => k.toUpperCase() === key) ?? key];
// A Windows system file by full path (%SystemRoot%\…): a bare name would be looked up in the current folder first (#97).
export const systemRoot = (env: Env, ...parts: string[]) => path.win32.join(envGet(env, 'SYSTEMROOT') || 'C:\\Windows', ...parts);
const isFileSync = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function findOnPath(cmd: string, env: Env, isFile: (p: string) => boolean, skip?: RegExp): string | undefined {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()); // NTFS ignores case
  const names = exts.some((e) => cmd.toLowerCase().endsWith(e)) ? [cmd, ...exts.map((e) => cmd + e)] : exts.map((e) => cmd + e);
  const dirs = /[\\/]/.test(cmd) ? [''] : (envGet(env, 'PATH') || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => path.win32.isAbsolute(d) && !skip?.test(d)); // "C:\\Tools\\gh bin" is valid; a relative entry never counts
  for (const d of dirs) for (const n of names) { const p = d ? path.win32.join(d, n) : n; if (isFile(p)) return p; }
  return undefined;
}

// The file and argv to hand to execFile/spawn for `cmd args` on this platform.
export function command(cmd: string, args: string[] = [], { platform = process.platform, env = process.env, isFile = isFileSync }: Resolve = {}): Command {
  if (/\.[cm]?js$/i.test(cmd)) return { file: process.execPath, args: [cmd, ...args] }; // a script override (FACTORY_GH=stub.mjs) runs under this node: no shebang on Windows
  if (platform !== 'win32') return { file: cmd, args };
  const file = findOnPath(cmd, env, isFile);
  // Not found: never hand the bare name to spawn, which on Windows looks in the current folder (maybe an untrusted clone) first.
  if (!file) throw Object.assign(new Error(`${cmd} is not installed`), { code: 'ENOENT' });
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args };
  const bad = args.find((a) => !PLAIN.test(a));
  if (bad !== undefined || /["%]/.test(file)) {
    throw new Error(`${path.win32.basename(file)} is a .cmd shim, and ${JSON.stringify(bad ?? file)} would need cmd.exe quoting; install a native ${cmd}.exe or run this step yourself`);
  }
  // /s strips the outer quotes, leaving "file" args; verbatim so Node adds no quoting of its own. The shim runs a bare `node`,
  // which cmd.exe would look for in the current folder (a run's worktree, maybe an untrusted clone) first: env turns that off.
  return { file: envGet(env, 'COMSPEC') || systemRoot(env, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], windowsVerbatimArguments: true,
    env: { NoDefaultCurrentDirectoryInExePath: '1' } };
}

const spawnOptions = <O extends { env?: NodeJS.ProcessEnv }>(c: Command, options: O): O =>
  ({ ...options, ...(c.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}), ...(c.env ? { env: { ...(options.env ?? process.env), ...c.env } } : {}) });
export function exec(cmd: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function exec(cmd: string, args?: string[], options?: ExecFileSyncOptions): string | Buffer;
export function exec(cmd: string, args: string[] = [], options: ExecFileSyncOptions = {}) {
  const c = command(cmd, args);
  return execFileSync(c.file, c.args, spawnOptions(c, options));
}

export function run(cmd: string, args: string[] = [], options: SpawnSyncOptions = {}) {
  let c: Command;
  try { c = command(cmd, args); } catch (error) { return { status: null, stdout: '', stderr: '', error: error as Error }; }
  return spawnSync(c.file, c.args, spawnOptions(c, options));
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
// The opener is spawned by the full path found, never by bare name (on Windows that is looked up in the current folder first).
export function open(target: string, { platform = process.platform, env = process.env, isFile = isFileSync }: Resolve = {}, launch = spawn) {
  const c = opener(target, platform), sys = systemRoot(env, c.file); // explorer.exe sits in %SystemRoot% itself
  const file = platform === 'win32' ? (isFile(sys) ? sys : findOnPath(c.file, env, isFile))
    : (envGet(env, 'PATH') || '').split(':').filter((d) => path.posix.isAbsolute(d)).map((d) => path.posix.join(d, c.file)).find(isFile);
  if (!file) throw new Error(`no ${c.file} here to open ${target}; open it yourself`);
  launch(file, c.args, { detached: true, stdio: 'ignore' }).on('error', () => { /* reported below by the caller's hint */ }).unref();
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
// Machine Path, then user Path, as Windows builds it. %VARS% are expanded only in a REG_EXPAND_SZ value, as Windows does.
// shortcut: reg.exe writes the OEM code page and this reads UTF-8, so a non-ASCII folder never matches; that fails safe (the
// folder counts as not on Path and the PowerShell line, which adds it only when missing, is printed). Upgrade: chcp 65001.
export function windowsPath(env: Env = process.env, run: (file: string, args: string[], o: object) => string = execFileSync as never) {
  const reg = systemRoot(env, 'System32', 'reg.exe');
  const read = (key: string) => {
    let m;
    try { m = /^\s*Path\s+REG_(EXPAND_)?SZ\s+(.*)$/im.exec(run(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return ''; }
    const v = m?.[2]?.trim() ?? '';
    return m?.[1] ? v.replace(/%([^%;]+)%/g, (x, name) => envGet(env, name) ?? x) : v;
  };
  return [read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')].join(';');
}

// Where install-cli writes: whichever of ~/.local/bin and ~/bin comes first on PATH, else ~/.local/bin (not yet on PATH).
// PATH entries are judged as absolute paths only, with a leading ~ meaning home on POSIX (cmd.exe and PowerShell don't
// expand it); relative ones never count.
export function cliDir(home: string, pathList: string, platform: NodeJS.Platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (d: string) => { const n = p.normalize(d).replace(/[\\/]+$/, ''); return platform === 'win32' ? n.toLowerCase() : n; };
  const local = p.join(home, '.local', 'bin'), dirs = [local, p.join(home, 'bin')];
  for (const e of pathList.split(platform === 'win32' ? ';' : ':')) {
    const abs = platform !== 'win32' && /^~(?=\/|$)/.test(e) ? p.join(home, e.slice(1)) : e;
    const hit = p.isAbsolute(abs) && dirs.find((d) => norm(d) === norm(abs));
    if (hit) return { dir: hit, onPath: true };
  }
  return { dir: local, onPath: false };
}

// The PowerShell line that adds dir to the user Path. It reads the raw value (DoNotExpandEnvironmentNames) and writes it back
// as REG_EXPAND_SZ, so %USERPROFILE%-style entries stay unexpanded, adds dir only when missing, then sets and clears a
// throwaway user variable so Windows broadcasts the change to new terminals. Not yet run on real Windows.
export const psAddToPath = (dir: string) => {
  const q = `'${dir.replace(/'/g, "''")}'`;
  return `$k = 'HKCU:\\Environment'; $p = (Get-Item $k).GetValue('Path', '', 'DoNotExpandEnvironmentNames'); if (($p -split ';') -notcontains ${q}) { Set-ItemProperty $k Path (($p.TrimEnd(';') + ';' + ${q}).TrimStart(';')) -Type ExpandString; [Environment]::SetEnvironmentVariable('FACTORY_PATH_REFRESH', '1', 'User'); [Environment]::SetEnvironmentVariable('FACTORY_PATH_REFRESH', $null, 'User') }   # PowerShell, then open a new terminal`;
};

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
    ? psAddToPath(dir)
    : fish ? `fish_add_path '${dir.replace(/['\\]/g, '\\$&')}'   # run once in fish`
    : `export PATH="${dir.replace(/["$`\\]/g, '\\$&')}:$PATH"   # add this line to your shell profile (~/.zshrc, ~/.bashrc), then open a new terminal`;
  return { dir, files: Object.keys(shims).map((n) => p.join(dir, n)), entry, ...(addToPath ? { onPath: false, addToPath } : { onPath: true }) };
}
