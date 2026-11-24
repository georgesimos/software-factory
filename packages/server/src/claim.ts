import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from '../../core/src/log.ts';

// One claim per run, across processes (#25): whoever starts a harness on a run (F start, F ui or the desktop app, a
// terminal pane) first creates the run's claim.json with 'wx', so two launchers can't both pass the checks and start. It
// holds the harness's pid and that process's start time, so a reused pid doesn't count. Unsure means live: a claim is taken
// over only once its process is positively gone (no such pid, or another start time). A claim with no pid yet, or one that
// can't be read, never goes stale by age. Every refusal names the way out for a person: F unclaim <run>, which refuses
// too while the claim may be live, unless --force.
export interface Claim { pid: number; since?: string; launcher: string; at: string; log?: string; token?: string }
const file = (id: string) => path.join(runDir(id), 'claim.json');

// The OS's start time for a pid, to tell it from a later process that got the same pid. Linux: the start in clock ticks
// since boot (/proc/<pid>/stat field 22), which a clock step doesn't move and which needs no ps. Elsewhere on POSIX:
// ps's lstart. shortcut: Windows has neither, so a claim there is checked by pid alone and a reused pid holds it until
// F unclaim; upgrade with a native query.
export function procStart(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32' || !(pid > 0)) return undefined;
  if (platform === 'linux') try { return statTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { /* no /proc: ps */ }
  try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
}
// "ticks:<n>" from a /proc/<pid>/stat line; the command name in parentheses may hold spaces and ')', so count from the last.
export const statTicks = (line: string) => { const n = line.slice(line.lastIndexOf(')') + 2).split(' ')[19]; return /^\d+$/.test(n ?? '') ? `ticks:${n}` : undefined; };
export function readClaim(id: string): Claim | undefined {
  try { const c = JSON.parse(fs.readFileSync(file(id), 'utf8')); return Number.isInteger(c?.pid) && typeof c.launcher === 'string' ? c : undefined; } catch { return undefined; }
}
// lstart ("Mon Nov 23 10:00:00 2026", UTC) in ms; NaN if it isn't one.
const lstart = (x?: string) => { const m = /^\w{3} +(\w{3}) +(\d{1,2}) +(\d\d):(\d\d):(\d\d) +(\d{4})$/.exec(x ?? ''); return m ? Date.parse(`${m[2]} ${m[1]} ${m[6]} ${m[3]}:${m[4]}:${m[5]} UTC`) : NaN; };
// pid 0 (claimed, not yet spawned) is live. Else live until shown gone: no such pid (EPERM is a pid that exists), or
// another start time: other ticks, or an lstart more than 5 s off (it drifts a second after an NTP step).
export function claimLive(c: Claim): boolean {
  if (c.pid === 0) return true;
  try { process.kill(c.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  const is = procStart(c.pid);
  if (c.since?.startsWith('ticks:') && is?.startsWith('ticks:')) return c.since === is;
  return !(Math.abs(lstart(c.since) - lstart(is)) > 5_000); // NaN (no start time, ps failed, mixed kinds) compares false: live
}
const dropClaim = (id: string, c: Claim) => { // only that claim: never one another launcher just took
  if (readClaim(id)?.token !== c.token) return;
  try { fs.unlinkSync(file(id)); } catch { /* gone */ }
};
// claim.json, whole or not at all: written aside, then linked in (create: fails if one exists) or renamed over it.
function put(id: string, c: Claim, create: boolean) {
  const tmp = `${file(id)}.${c.token}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c));
  try {
    if (!create) fs.renameSync(tmp, file(id));
    else try { fs.linkSync(tmp, file(id)); } catch (e) { // no hard links (FAT, some shares): a plain exclusive create
      if (!['EPERM', 'ENOTSUP', 'ENOSYS'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      fs.writeFileSync(file(id), JSON.stringify(c), { flag: 'wx' });
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
// Takes the run, or throws while a live launcher holds it. update() records the pid once spawned; release() lets go.
export function takeClaim(id: string, launcher: string, fields: Partial<Claim> = {}) {
  fs.mkdirSync(runDir(id), { recursive: true });
  const c: Claim = { pid: 0, launcher, at: new Date().toISOString(), token: crypto.randomUUID(), ...fields };
  for (let tries = 0; ; tries++) {
    try { put(id, c, true); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const old = readClaim(id);
      if (tries || !old || claimLive(old)) throw running(id, old); // unreadable: never guessed stale
      // shortcut: two launchers taking over one stale claim at once can, between dropClaim's re-read and its unlink (a
      // window of microseconds), drop the other's fresh claim; build a lock-free takeover only if that ever shows up.
      dropClaim(id, old);
    }
  }
  return {
    claim: c,
    update(more: Partial<Claim>) { // only while it's still ours: F unclaim --force may have cleared it, and another launcher taken it
      const now = readClaim(id);
      if (now?.token !== c.token) throw new Error(`${id}'s claim was cleared${now ? ` and taken by ${now.launcher}` : ''} (F unclaim) before this harness started: stopped it`);
      // shortcut: a takeover between this re-read and the rename (microseconds) is still overwritten; lock it if that shows up.
      Object.assign(c, more); put(id, c, false);
    },
    release() { dropClaim(id, c); },
  };
}
export const running = (id: string, c = readClaim(id)) => new Error(`${id} already has a running session (${c ? `${c.launcher}${c.pid ? `, pid ${c.pid}` : ', not started yet'}` : 'unreadable claim'}). `
  + (c?.pid ? `If that process is gone: F unclaim ${id}` : `If nothing is starting it (check for a running claude on ${id} first): F unclaim ${id} --force`) + ` (it deletes ${file(id)})`);
// The factory's own steps on a run (#105: F intake, approval, worktree; F queue's picks) yield to another live launcher's
// claim. The holder's harness passes: its launcher hands it the claim's token in FACTORY_CLAIM (env only: never argv or the
// log). Returns the blocking claim (null: unreadable, so live), or undefined when the run is free or the claim is ours.
export function claimedElsewhere(id: string, env: NodeJS.ProcessEnv = process.env): Claim | null | undefined {
  try { fs.lstatSync(file(id)); } catch { return undefined; }
  const c = readClaim(id);
  if (c?.token && c.token === env.FACTORY_CLAIM) return undefined;
  return !c ? null : claimLive(c) ? c : undefined;
}
export function refuseClaimed(id: string, env: NodeJS.ProcessEnv = process.env) {
  const c = claimedElsewhere(id, env);
  if (c !== undefined) throw running(id, c ?? undefined);
}
// The env for a harness on a run: its claim's token, and never one inherited from whoever started this process.
export const withClaim = (env: NodeJS.ProcessEnv, token?: string) => { const { FACTORY_CLAIM: _, ...rest } = env; return token ? { ...rest, FACTORY_CLAIM: token } : rest; };
// F unclaim <run>: a person clears a claim that blocks the run. Refused while it may be live (unreadable included), unless forced.
export function unclaim(id: string, force = false) {
  try { fs.lstatSync(file(id)); } catch { return { unclaimed: false, why: 'no claim' }; } // lstat: a dangling symlink is a claim too
  const c = readClaim(id);
  if (!force && (!c || claimLive(c))) throw new Error(`${id}'s claim is ${c ? `live${c.pid ? ` (pid ${c.pid})` : ' (not started yet)'}` : 'unreadable'}: stop that process first, or (check for a running claude on ${id} first) F unclaim ${id} --force`);
  // shortcut: no token re-check, so a claim a launcher takes over between the read above and this delete (microseconds) is
  // deleted too; a person runs this once a run is stuck, so add the check if it ever races a launcher.
  try { fs.unlinkSync(file(id)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // unlink, not rmSync: that leaves a dangling symlink in place
  return { unclaimed: true, ...(c && { pid: c.pid, launcher: c.launcher }) };
}
