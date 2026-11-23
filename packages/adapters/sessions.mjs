// Runs what a harness's launch() describes and keeps its events in memory for the server to stream (ADR §5).
// Outside harnesses/, so the registry never loads it as a harness. headless spawns the CLI; terminal needs node-pty and
// sdk the harness's SDK. Neither is a dependency of F: the host passes them in (modules.pty, modules.sdk), else they are
// imported lazily by name. argv only, never a shell (core/src/platform.ts).
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

// h: the harness adapter; opts go to h.launch(); cwd and env are the host's, never the request's. resolve is for tests:
// command()'s platform, env and file lookup (core/src/platform.ts).
export function startSession(h, opts, { cwd, env = process.env, label = '', modules = {}, resolve }) {
  if (typeof h.launch !== 'function' || !(h.modes || []).includes(opts.mode)) throw new Error(`${h.id} cannot launch in ${opts.mode} mode`);
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
  const fail = (e) => { emit(s, { type: 'error', message: e.message }); done(null); };
  if (opts.mode === 'terminal') { terminal(s, spec, { cwd, env, modules, resolve, done }).catch(fail); return s; }
  if (opts.mode === 'sdk') { sdk(s, spec, { cwd, env, modules, done }).catch(fail); return s; }
  let c;
  try { c = command(spec.cmd, spec.args, resolve); } catch (e) { fail(e); return s; }
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

const load = async (given, name, what) => {
  if (given) return given;
  try { return await import(name); } catch (e) {
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(e.code)) throw new Error(`${what} needs ${name}, which is not installed here`);
    throw new Error(`${what}: loading ${name} failed: ${e.message}`);
  }
};

// An interactive harness in a pseudo-terminal (ConPTY on Windows). Output is raw terminal data for xterm.js; input and
// resize come back through write() and resize().
async function terminal(s, spec, { cwd, env, modules, resolve, done }) {
  let stopped = false;
  s.stop = () => { stopped = true; }; // a stop while node-pty loads
  const pty = await load(modules.pty, 'node-pty', 'terminal mode');
  if (stopped) return done('stopped');
  const c = command(spec.cmd, spec.args, resolve);
  // A .cmd shim's cmd.exe line goes to node-pty as one string: given an array, node-pty quotes each argument again.
  const p = pty.spawn(c.file, c.windowsVerbatimArguments ? c.args.join(' ') : c.args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env });
  s.write = (data) => p.write(data);
  s.resize = (cols, rows) => p.resize(cols, rows);
  s.stop = () => p.kill();
  p.onData((data) => emit(s, { type: 'output', data }));
  p.onExit(({ exitCode }) => done(exitCode));
}

// The harness's SDK in this process (it runs its own CLI binary as a child, with the host's env). Each SDK message is one
// event. The exit code comes from the last result message: 0 for a success, 1 for an error subtype, is_error, or none.
async function sdk(s, spec, { cwd, env, modules, done }) {
  const abortController = new AbortController();
  s.stop = () => abortController.abort(); // before the await, so a stop while the SDK loads is kept
  const mod = await load(modules.sdk, spec.module, 'sdk mode');
  if (abortController.signal.aborted) return done('stopped');
  let result;
  for await (const m of mod.query({ prompt: spec.prompt, options: { ...spec.options, cwd, env, abortController } })) {
    if (m?.type === 'result') result = m;
    emit(s, { type: 'event', data: m });
  }
  done(result?.subtype === 'success' && !result.is_error ? 0 : 1);
}
