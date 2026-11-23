// Runs what a harness's launch() describes and keeps its events in memory for the server to stream (ADR §5).
// Outside harnesses/, so the registry never loads it as a harness. Headless only for now; terminal (node-pty) and sdk are
// H1 part 2, loaded lazily here so F itself stays dependency-free. argv only, never a shell (core/src/platform.ts).
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { command } from '../core/src/platform.ts';

const MAX_EVENTS = 5000; // per session; older ones are dropped, and a replay that reaches back past them starts with a 'dropped' event
const KEEP_EXITED = 50; // finished sessions kept for replay; older ones are forgotten
const sessions = new Map();

export const getSession = (id) => sessions.get(id);
export const listSessions = () => [...sessions.values()].map(({ id, harness, mode, label, state, exit, started }) => ({ id, harness, mode, label, state, exit, started }));

function emit(s, e) {
  const ev = { n: s.next++, at: new Date().toISOString(), ...e };
  s.events.push(ev);
  if (s.events.length > MAX_EVENTS) s.events.shift();
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

// h: the harness adapter; opts go to h.launch(); cwd and env are the host's, never the request's.
export function startSession(h, opts, { cwd, env = process.env, label = '' }) {
  if (typeof h.launch !== 'function' || !(h.modes || []).includes(opts.mode)) throw new Error(`${h.id} cannot launch in ${opts.mode} mode`);
  if (opts.mode !== 'headless') throw new Error(`${opts.mode} mode is not available yet (H1 part 2)`);
  const spec = h.launch(opts);
  const s = { id: crypto.randomUUID(), harness: h.id, mode: opts.mode, label, state: 'running', exit: null, started: new Date().toISOString(), events: [], next: 0, listeners: new Set(), stop: () => {} };
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
  try { c = command(spec.cmd, spec.args); } catch (e) { emit(s, { type: 'error', message: e.message }); done(null); return s; }
  // spec.stdin carries the prompt: as an argument its space and # would need cmd.exe quoting, which a .cmd shim can't get
  const child = spawn(c.file, c.args, { cwd, env, stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsVerbatimArguments: !!c.windowsVerbatimArguments });
  if (spec.stdin !== undefined) child.stdin.on('error', () => { /* exited before reading it: reported by close */ }).end(spec.stdin);
  s.stop = () => { if (child.pid) child.kill(); }; // a spawn that failed with ENOENT keeps pid 0, and kill(0) signals our whole process group
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let data;
    try { data = JSON.parse(line); } catch { return emit(s, { type: 'text', data: line }); }
    emit(s, { type: 'event', data });
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => emit(s, { type: 'stderr', data: line }));
  child.on('error', (e) => { emit(s, { type: 'error', message: e.code === 'ENOENT' ? `${spec.cmd} is not installed` : e.message }); done(null); });
  child.on('close', (code, signal) => done(code ?? signal)); // after stdout and stderr end, so every line is in; a kill gives its signal
  return s;
}
