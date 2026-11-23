import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from '../../core/src/log.ts';

// One claim per run, across processes (#25): whoever starts a harness on a run (F start, F ui or the desktop app, a
// terminal pane) first creates the run's claim.json with 'wx', so two launchers can't both pass the checks and start. It
// holds the pid that owns the run and that process's start time, so a reused pid doesn't count. A claim whose process is
// gone is stale: the next launcher takes it over (and may resume the harness session it names).
export interface Claim { pid: number; since?: string; launcher: string; at: string; log?: string; token?: string }
const file = (id: string) => path.join(runDir(id), 'claim.json');

// The OS's start time for a pid, to tell it from a later process that got the same pid. shortcut: POSIX only (ps); on
// Windows a claim is checked by pid alone, so a reused pid holds it until the run's next start; upgrade with a native query.
export function procStart(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32' || !(pid > 0)) return undefined;
  try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
}
export function readClaim(id: string): Claim | undefined {
  try { const c = JSON.parse(fs.readFileSync(file(id), 'utf8')); return Number.isInteger(c?.pid) && typeof c.launcher === 'string' ? c : undefined; } catch { return undefined; }
}
// pid 0: a launcher between its claim and its spawn, for a minute at most. EPERM is a process that isn't ours.
export function claimLive(c: Claim, now = Date.now()): boolean {
  if (c.pid === 0) return now - Date.parse(c.at) < 60_000;
  try { process.kill(c.pid, 0); } catch { return false; }
  const since = procStart(c.pid);
  return !c.since || !since || since === c.since; // ps failing proves nothing: the pid lives
}
export const dropClaim = (id: string, c?: Claim) => { // only that claim, when given: never one another launcher just took
  if (c && readClaim(id)?.token !== c.token) return;
  try { fs.unlinkSync(file(id)); } catch { /* gone */ }
};
// Takes the run, or throws while a live launcher holds it. update() records the pid once spawned; release() lets go.
export function takeClaim(id: string, launcher: string, fields: Partial<Claim> = {}) {
  fs.mkdirSync(runDir(id), { recursive: true });
  const c: Claim = { pid: 0, launcher, at: new Date().toISOString(), token: crypto.randomUUID(), ...fields };
  for (let tries = 0; ; tries++) {
    try { fs.writeFileSync(file(id), JSON.stringify(c), { flag: 'wx' }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (tries) throw running(id); // another launcher took it between our takeover and our create
      const old = readClaim(id);
      if (old ? claimLive(old) : young(id)) throw running(id, old); // unreadable and new: another launcher mid-write
      dropClaim(id, old); // stale (or unreadable): take it over, once. shortcut: two takeovers racing between dropClaim's re-read and
      // its unlink can drop the other's fresh claim (a window of microseconds); rename-then-verify if that ever shows up
    }
  }
  return {
    claim: c,
    update(more: Partial<Claim>) { Object.assign(c, more); fs.writeFileSync(file(id), JSON.stringify(c)); },
    release() { dropClaim(id, c); },
  };
}
const young = (id: string) => { try { return Date.now() - fs.statSync(file(id)).mtimeMs < 60_000; } catch { return false; } };
const running = (id: string, c = readClaim(id)) => new Error(`${id} already has a running session${c ? ` (${c.launcher}${c.pid ? `, pid ${c.pid}` : ''})` : ''}`);
