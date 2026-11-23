import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Opened from Finder or the Dock (launchd) or a Linux desktop launcher, the app gets a minimal PATH, and claude, codex
// and gh, on the login shell's PATH, read as not installed. The login shell's entries go first, then any of ours it
// lacks. Markers around the value: an interactive rc file may print to stdout. Windows apps get the user's PATH already.
const MARK = '__SF_PATH__';
const shell = (sh: string) => execFileSync(sh, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] });
export function loginPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, run = shell): string | undefined {
  if (platform !== 'darwin' && platform !== 'linux') return env.PATH;
  try {
    const got = run(env.SHELL || '/bin/sh').split(MARK)[1];
    if (!got) return env.PATH;
    return [...new Set([...got.split(path.delimiter), ...(env.PATH ?? '').split(path.delimiter)].filter(Boolean))].join(path.delimiter);
  } catch { return env.PATH; } // no shell, a timeout, or an rc file that fails: keep what we have
}
