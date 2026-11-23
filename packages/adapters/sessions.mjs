// Runs what a harness's launch() describes and keeps its events in memory for the server to stream (ADR §5).
// Outside harnesses/, so the registry never loads it as a harness. Headless only for now; terminal (node-pty) and sdk are
// H1 part 2, loaded lazily here so F itself stays dependency-free. argv only, never a shell (core/src/platform.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { command } from '../core/src/platform.ts';

// Per session, older events are dropped past either cap, and a replay that reaches back past them starts with a 'dropped' event.
const MAX_EVENTS = 5000;
export const MAX_BYTES = 4 * 1024 * 1024; // as JSON; with KEEP_EXITED, memory stays bounded (~84 MB plus running sessions)
const KEEP_EXITED = 20; // finished sessions kept for replay; older ones are forgotten
const sessions = new Map();

export const getSession = (id) => sessions.get(id);
export const listSessions = () => [...sessions.values()].map(({ id, harness, mode, label, state, exit, started, ended, harnessSession }) => ({ id, harness, mode, label, state, exit, started, ended, harnessSession }));
// A run that a killed session leaves active is resumed from it (server.ts), so its newest one is never forgotten, only emptied.
const resumable = (x) => x.exit !== 0 && x.harnessSession && [...sessions.values()].filter((y) => y.label === x.label).at(-1) === x;

function emit(s, e) {
  const ev = { n: s.next++, at: new Date().toISOString(), ...e };
  s.events.push(ev); s.bytes += JSON.stringify(ev).length;
  while (s.events.length > 1 && (s.events.length > MAX_EVENTS || s.bytes > MAX_BYTES)) s.bytes -= JSON.stringify(s.events.shift()).length;
  for (const f of s.listeners) f(ev);
}
// Subscribe from event n on: replays what is buffered, then live events. Returns the unsubscribe function.
export function subscribe(s, fn, from = 0) {
  const first = s.events[0]?.n;
  if (first !== undefined && from < first) fn({ type: 'dropped', from, first }); // no n: not a position to resume from
  for (const e of s.events) if (e.n >= from) fn(e);
  if (s.state !== 'running') return () => {};
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

// The file and argv for a spec, found on the PATH (and PATHEXT) that the spawn gets, not this process's.
export const resolveSpec = (spec, env, resolve) => command(spec.cmd, spec.args, { env, ...resolve });

// Stops a child and everything under it (claude's Bash tools: dev servers, watchers). Windows: taskkill /T, since through a
// .cmd shim kill() would end only cmd.exe. POSIX: the child leads its own process group (spawned detached), so the group
// gets SIGTERM. A spawn that failed with ENOENT keeps pid 0, and kill(0) or kill(-0) would signal our own group.
export function killTree(child, platform = process.platform, run = spawn, kill = process.kill) {
  if (!child.pid) return;
  if (platform === 'win32') run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => { /* taskkill missing: nothing else to try */ });
  else try { kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } // the group is gone: the child alone, if it is not
}
// Detached children don't get the terminal's Ctrl-C, so a running session is stopped when this process ends.
const stopAll = () => { for (const s of sessions.values()) if (s.state === 'running') s.stop(); };
process.once('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { stopAll(); process.kill(process.pid, sig); }); // then the default action

// h: the harness adapter; opts go to h.launch(); cwd and env are the host's, never the request's. resolve is for tests:
// command()'s platform and file lookup (core/src/platform.ts).
export function startSession(h, opts, { cwd, env = process.env, label = '', resolve }) {
  if (typeof h.launch !== 'function' || !(h.modes || []).includes(opts.mode)) throw new Error(`${h.id} cannot launch in ${opts.mode} mode`);
  if (opts.mode !== 'headless') throw new Error(`${opts.mode} mode is not available yet (H1 part 2)`);
  const spec = h.launch(opts);
  const s = { id: crypto.randomUUID(), harness: h.id, mode: opts.mode, label, state: 'running', exit: null, started: new Date().toISOString(), events: [], next: 0, listeners: new Set(), bytes: 0, stop: () => {}, harnessSession: undefined, ended: null };
  sessions.set(s.id, s);
  const done = (exit) => {
    if (s.state !== 'running') return;
    s.state = 'exited'; s.exit = exit; s.ended = new Date().toISOString();
    emit(s, { type: 'exit', code: exit });
    s.listeners.clear(); s.stop = () => {};
    const old = [...sessions.values()].filter((x) => x.state !== 'running');
    for (const x of old.slice(0, -KEEP_EXITED)) if (resumable(x)) Object.assign(x, { events: [], bytes: 0 }); else sessions.delete(x.id);
  };
  if (cwd && !fs.existsSync(cwd)) { emit(s, { type: 'error', message: `the folder ${cwd} does not exist` }); done(null); return s; } // else ENOENT reads as "not installed"
  let c;
  try { c = resolveSpec(spec, env, resolve); } catch (e) { emit(s, { type: 'error', message: e.message }); done(null); return s; }
  // spec.stdin carries the prompt: as an argument its space and # would need cmd.exe quoting, which a .cmd shim can't get
  const child = spawn(c.file, c.args, { cwd, env, stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsVerbatimArguments: !!c.windowsVerbatimArguments });
  if (spec.stdin !== undefined) child.stdin.on('error', () => { /* exited before reading it: reported by close */ }).end(spec.stdin);
  s.stop = () => killTree(child);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let data;
    try { data = JSON.parse(line); } catch { return emit(s, { type: 'text', data: line }); }
    if (s.harnessSession === undefined && typeof data?.session_id === 'string') s.harnessSession = data.session_id; // kept past the event caps
    emit(s, { type: 'event', data });
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => emit(s, { type: 'stderr', data: line }));
  child.on('error', (e) => { emit(s, { type: 'error', message: e.code === 'ENOENT' ? `${spec.cmd} is not installed` : e.message }); if (!child.pid) done(null); }); // else close follows
  child.on('close', (code, signal) => done(code ?? signal)); // after stdout and stderr end, so every line is in; a kill gives its signal
  return s;
}
