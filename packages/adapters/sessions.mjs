// Runs what a harness's launch() describes and keeps its events in memory for the server to stream (ADR §5).
// Outside harnesses/, so the registry never loads it as a harness. Headless only for now; terminal (node-pty) and sdk are
// H1 part 2, loaded lazily here so F itself stays dependency-free. argv only, never a shell (core/src/platform.ts).
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { command } from '../core/src/platform.ts';

// Per session, older events are dropped past either cap, and a replay that reaches back past them starts with a 'dropped' event.
const MAX_EVENTS = 5000;
export const MAX_BYTES = 4 * 1024 * 1024; // as JSON; with KEEP_EXITED, memory stays bounded (~84 MB plus running sessions)
const KEEP_EXITED = 20; // finished sessions kept for replay; older ones are forgotten
const sessions = new Map();

export const getSession = (id) => sessions.get(id);
export const listSessions = () => [...sessions.values()].map(({ id, harness, mode, label, state, exit, started }) => ({ id, harness, mode, label, state, exit, started }));

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

// Stops a child and, on Windows, everything under it: through a .cmd shim, kill() would end cmd.exe and leave the paid
// claude run going. A spawn that failed with ENOENT keeps pid 0, and kill(0) would signal our whole process group.
export function killTree(child, platform = process.platform, run = spawn) {
  if (!child.pid) return;
  if (platform === 'win32') run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => { /* taskkill missing: nothing else to try */ });
  else child.kill();
}

// h: the harness adapter; opts go to h.launch(); cwd and env are the host's, never the request's. resolve is for tests:
// command()'s platform and file lookup (core/src/platform.ts).
export function startSession(h, opts, { cwd, env = process.env, label = '', resolve }) {
  if (typeof h.launch !== 'function' || !(h.modes || []).includes(opts.mode)) throw new Error(`${h.id} cannot launch in ${opts.mode} mode`);
  if (opts.mode !== 'headless') throw new Error(`${opts.mode} mode is not available yet (H1 part 2)`);
  const spec = h.launch(opts);
  const s = { id: crypto.randomUUID(), harness: h.id, mode: opts.mode, label, state: 'running', exit: null, started: new Date().toISOString(), events: [], next: 0, listeners: new Set(), bytes: 0, stop: () => {} };
  sessions.set(s.id, s);
  const done = (exit) => {
    if (s.state !== 'running') return;
    s.state = 'exited'; s.exit = exit;
    emit(s, { type: 'exit', code: exit });
    s.listeners.clear(); s.stop = () => {};
    const old = [...sessions.values()].filter((x) => x.state !== 'running');
    for (const x of old.slice(0, -KEEP_EXITED)) sessions.delete(x.id);
  };
  let c;
  try { c = resolveSpec(spec, env, resolve); } catch (e) { emit(s, { type: 'error', message: e.message }); done(null); return s; }
  // spec.stdin carries the prompt: as an argument its space and # would need cmd.exe quoting, which a .cmd shim can't get
  const child = spawn(c.file, c.args, { cwd, env, stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsVerbatimArguments: !!c.windowsVerbatimArguments });
  if (spec.stdin !== undefined) child.stdin.on('error', () => { /* exited before reading it: reported by close */ }).end(spec.stdin);
  s.stop = () => killTree(child);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let data;
    try { data = JSON.parse(line); } catch { return emit(s, { type: 'text', data: line }); }
    emit(s, { type: 'event', data });
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => emit(s, { type: 'stderr', data: line }));
  child.on('error', (e) => { emit(s, { type: 'error', message: e.code === 'ENOENT' ? `${spec.cmd} is not installed` : e.message }); if (!child.pid) done(null); }); // else close follows
  child.on('close', (code, signal) => done(code ?? signal)); // after stdout and stderr end, so every line is in; a kill gives its signal
  return s;
}
