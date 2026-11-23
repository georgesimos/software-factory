import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Opened from Finder or the Dock (launchd) or a Linux desktop launcher, the app gets a minimal PATH, and claude, codex
// and gh, on the login shell's PATH, read as not installed. Markers around the value: an rc file may print to stdout,
// even the marker, so the last complete span wins. Windows apps get the user's PATH already.
const MARK = '__SF_PATH__';
const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin';
type Run = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number; killSignal: NodeJS.Signals; stdio: ['ignore', 'pipe', 'ignore'] }) => string;
export function loginPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, run: Run = execFileSync): string | undefined {
  if (platform !== 'darwin' && platform !== 'linux') return env.PATH;
  const sh = env.SHELL || '/bin/sh';
  const value = path.basename(sh) === 'fish' ? '(string join : $PATH)' : '"$PATH"'; // fish's "$PATH" joins with spaces
  try {
    // SIGKILL: an interactive shell ignores SIGTERM, and a slow rc file would hold the window back past the timeout
    const parts = run(sh, ['-ilc', `printf '${MARK}%s${MARK}' ${value}`], { env, encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] }).split(MARK);
    const got = parts.length >= 3 ? parts[parts.length - 2] : '';
    if (!got) return env.PATH;
    // launchd's bare default: the login shell's order (Homebrew before /usr/bin). Else ours first: a test's stubs win.
    const ours = (env.PATH ?? '').split(path.delimiter), theirs = got.split(path.delimiter);
    return [...new Set((env.PATH === LAUNCHD ? [...theirs, ...ours] : [...ours, ...theirs]).filter(Boolean))].join(path.delimiter);
  } catch { return env.PATH; } // no shell, a timeout, or an rc file that fails: keep what we have
}
