// Runs what a harness's launch() describes and keeps its events in memory for the server to stream (ADR §5).
// Outside harnesses/, so the registry never loads it as a harness. headless spawns the CLI; terminal needs node-pty and
// sdk the harness's SDK. Neither is a dependency of F: the host passes them in, keyed by package name (modules['node-pty'],
// modules['@anthropic-ai/claude-agent-sdk']), else they are imported lazily by name. argv only, never a shell (core/src/platform.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { command } from '../core/src/platform.ts';

// Per session, older events are dropped past either cap, and a replay that reaches back past them starts with a 'dropped' event.
const MAX_EVENTS = 5000;
export const MAX_BYTES = 4 * 1024 * 1024; // as JSON; with KEEP_EXITED, memory stays bounded (~84 MB plus running sessions)
const KEEP_EXITED = 20; // finished sessions kept for replay; older ones are forgotten
const sessions = new Map();

export const getSession = (id) => sessions.get(id);
export const listSessions = () => [...sessions.values()].map(({ id, harness, mode, label, state, exit, started, ended, harnessSession }) => ({ id, harness, mode, label, state, exit, started, ended, harnessSession }));
// A run that a killed session leaves active is resumed from it (server.ts), so its newest one is never forgotten, only emptied.
const resumable = (x) => x.exit !== 0 && x.harnessSession && [...sessions.values()].filter((y) => y.label === x.label && y.mode !== 'terminal').at(-1) === x;

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
// wait: on quit, taskkill runs to the end (5 s at most) before this returns: Electron can exit first otherwise, and taskkill,
// in the same kill-on-close job, dies with it while claude keeps writing in the worktree. Signals are synchronous anyway.
export function killTree(child, platform = process.platform, run, kill = process.kill, wait = false) {
  if (!child.pid) return;
  const args = ['/pid', String(child.pid), '/T', '/F'];
  if (platform !== 'win32') try { kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } // the group is gone: the child alone, if it is not
  else if (wait) (run ?? spawnSync)('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
  else (run ?? spawn)('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => { /* taskkill missing: nothing else to try */ });
}
// Detached children don't get the terminal's Ctrl-C, so a running session is stopped when this process ends: waited for,
// since nothing after 'exit' or quit gets another turn of the event loop.
export const stopAll = () => { for (const s of sessions.values()) if (s.state === 'running') { s.stop(true); s.stop = () => {}; } }; // once: quit, then 'exit', would taskkill twice
process.once('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { stopAll(); process.kill(process.pid, sig); }); // then the default action

// h: the harness adapter; opts go to h.launch(); cwd and env are the host's, never the request's. resolve is for tests:
// command()'s platform and file lookup (core/src/platform.ts).
export function startSession(h, opts, { cwd, env = process.env, label = '', modules = {}, resolve }) {
  if (typeof h.launch !== 'function' || !(h.modes || []).includes(opts.mode)) throw new Error(`${h.id} cannot launch in ${opts.mode} mode`);
  if (opts.mode === 'terminal' && opts.budget != null) throw new Error('a terminal session has no budget cap: run headless or sdk for a budget');
  const spec = h.launch(opts);
  const s = { id: crypto.randomUUID(), harness: h.id, mode: opts.mode, label, cwd, state: 'running', exit: null, started: new Date().toISOString(), events: [], next: 0, listeners: new Set(), bytes: 0, stop: () => {}, harnessSession: undefined, ended: null };
  sessions.set(s.id, s);
  const done = (exit) => {
    if (s.state !== 'running') return;
    s.state = 'exited'; s.exit = exit; s.ended = new Date().toISOString();
    emit(s, { type: 'exit', code: exit });
    s.listeners.clear(); s.stop = () => {};
    const old = [...sessions.values()].filter((x) => x.state !== 'running');
    for (const x of old.slice(0, -KEEP_EXITED)) if (resumable(x)) Object.assign(x, { events: [], bytes: 0 }); else sessions.delete(x.id);
  };
  const fail = (e) => { emit(s, { type: 'error', message: e.message }); done(null); };
  if (cwd && !fs.existsSync(cwd)) { fail(new Error(`the folder ${cwd} does not exist`)); return s; } // else ENOENT reads as "not installed"
  if (opts.mode === 'terminal') { terminal(s, spec, { cwd, env, modules, resolve, done }).catch(fail); return s; }
  if (opts.mode === 'sdk') { sdk(s, spec, { cwd, env, modules, done }).catch(fail); return s; }
  let c;
  try { c = resolveSpec(spec, env, resolve); } catch (e) { fail(e); return s; }
  // spec.stdin carries the prompt: as an argument its space and # would need cmd.exe quoting, which a .cmd shim can't get
  const child = spawn(c.file, c.args, { cwd, env, stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsVerbatimArguments: !!c.windowsVerbatimArguments });
  if (spec.stdin !== undefined) child.stdin.on('error', () => { /* exited before reading it: reported by close */ }).end(spec.stdin);
  s.stop = (wait) => killTree(child, process.platform, undefined, process.kill, wait);
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

// The host's module (modules keyed by package name), else an import() by name. Under pnpm that import resolves from
// packages/adapters only, so a host that ships the module (apps/desktop) must pass it in (ADR 0001).
const load = async (modules, name, what) => {
  if (modules[name]) return modules[name];
  try { return await import(name); } catch (e) {
    const missing = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(e.code) && String(e.message).includes(`'${name}'`); // not a dependency of it
    throw new Error(missing ? `${what} needs ${name}, which is not installed here` : `${what}: loading ${name} failed: ${e.message}`);
  }
};

// Whether the binary a spawn was given exists. On Windows command() already returned a found one as a full path.
const onPath = (file, env) => /[\\/]/.test(file) ? fs.existsSync(file)
  : process.platform !== 'win32' && String(env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, file)));

// An interactive harness in a pseudo-terminal (ConPTY on Windows). Output is raw terminal data for xterm.js; input and
// resize come back through write() and resize(). Exit: 'stopped' after stop(), else the signal, else the exit code.
async function terminal(s, spec, { cwd, env, modules, resolve, done }) {
  let stopped = false;
  s.stop = () => { stopped = true; }; // a stop while node-pty loads
  const pty = await load(modules, 'node-pty', 'terminal mode');
  if (stopped) return done('stopped');
  const c = resolveSpec(spec, env, resolve);
  let p;
  // A .cmd shim's cmd.exe line goes to node-pty as one string: given an array, node-pty quotes each argument again.
  try { p = pty.spawn(c.file, c.windowsVerbatimArguments ? c.args.join(' ') : c.args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env }); } catch (e) {
    throw onPath(c.file, env) ? e : new Error(`${spec.cmd} is not installed`); // else a bad cwd or a broken pty passes through
  }
  s.write = (data) => { if (!stopped) p.write(data); }; // a stopped pty may already be gone
  s.resize = (cols, rows) => { if (!stopped) p.resize(cols, rows); };
  s.stop = () => { stopped = true; killTree({ pid: p.pid, kill() {} }, process.platform, undefined, process.kill, true); try { p.kill(); } catch { /* gone */ } }; // the tree first, waited (taskkill /T on Windows walks it from the live root), then the pty
  p.onData((data) => emit(s, { type: 'output', data }));
  p.onExit(({ exitCode, signal }) => done(stopped ? 'stopped' : signal || exitCode));
}

// The harness's SDK in this process (it runs its own CLI binary as a child, with the host's env). Each SDK message is one
// event. Exit: 'stopped' after stop(); else 0 for a success result, 1 for an error subtype, is_error, or no result.
async function sdk(s, spec, { cwd, env, modules, done }) {
  const abortController = new AbortController(), aborted = () => abortController.signal.aborted;
  s.stop = () => abortController.abort(); // before the await, so a stop while the SDK loads is kept
  const mod = await load(modules, spec.module, 'sdk mode');
  if (aborted()) return done('stopped');
  let result;
  try {
    for await (const m of mod.query({ prompt: spec.prompt, options: { ...spec.options, cwd, env, abortController } })) {
      if (m?.type === 'result') result = m;
      emit(s, { type: 'event', data: m });
    }
  } catch (e) { if (!aborted()) throw e; } // an abort ends the iterator with an AbortError
  done(aborted() ? 'stopped' : result?.subtype === 'success' && !result.is_error ? 0 : 1);
}
