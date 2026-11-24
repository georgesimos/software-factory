// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CAP, COST_CAP, TERMINAL, TOKEN_CAP } from '../../core/src/constants.ts';
import { hooks, loadShipList } from '../../core/src/ship.ts';
import { LOGIN, rules, setAutoMerge, setRule, unsetRule } from '../../core/src/rules.ts';
import { budget, budgetWhy, derive } from '../../core/src/derive.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { ideas, startIdea } from '../../core/src/project.ts';
import { metrics } from '../../core/src/gate.ts';
import { fCmd, onboardConfig, onboardState, readOnboard, setShip } from '../../core/src/onboard.ts';
import { projects, wtInfo } from '../../core/src/workspace.ts';
import { HOST_ID, dashboard, read, readArchive, runDir, sessionsFile, stateDir } from '../../core/src/log.ts';
import { applyPreset, readSkills, setSkill, skillsData } from '../../core/src/skills.ts';
import { sync } from '../../core/src/sync.ts';
import { note } from '../../core/src/notes.ts';
import { measure, withMeasured } from '../../core/src/burn.ts';
import { logMetrics } from '../../core/src/metrics.ts';
import { open } from '../../core/src/platform.ts';
import { spawn } from 'node:child_process';
import { childEnv, getSession, killTree, listSessions, resolveSpec, startSession, stopAll, subscribe } from '../../adapters/sessions.mjs';
import { claimedElsewhere, claimLive, procStart, readClaim, refuseClaimed, running, takeClaim, withClaim } from '../../core/src/claim.ts';

// `F ui`: the dashboard on a loopback port, where the Skills sheet can save. Pure, so the self-test can drive it.
export const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// apps/web's single-file build (#55), committed so plugin and skill installs need no build step: `pnpm --filter
// @software-factory/web dashboard` rebuilds it. F render fills its #data tag; F ui serves it unfilled, and it reads GET /api/state.
export const APP_HTML = path.join(import.meta.dirname, '..', '..', 'factory', 'app.html');
export function uiHandle({ method, url, headers = {}, body = '' }, { token, port }) {
  const reply = (status, x) => ({ status, type: 'application/json', body: JSON.stringify(x) });
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(headers.host)) return reply(403, { error: 'unexpected Host header' }); // DNS rebinding
  const u = new URL(url, 'http://local');
  if (method === 'GET' && u.pathname === '/') {
    if (!same(u.searchParams.get('t'), token)) return reply(403, { error: 'open the URL that `F ui` printed' });
    return { status: 200, type: 'text/html; charset=utf-8', body: fs.readFileSync(APP_HTML, 'utf8') }; // no data: injected data would be a snapshot the page never refreshes
  }
  if (method === 'GET' && (u.pathname === '/app' || u.pathname.startsWith('/app/'))) return { status: 308, type: 'text/plain; charset=utf-8', body: '', location: '/' + u.search }; // the preview URL before #55
  const route = u.pathname.startsWith('/api/') ? u.pathname.slice(4) : u.pathname; // /api/<p> and the original <p> are one route
  if (method === 'GET' && u.pathname.startsWith('/api/')) { // reads: same token; browsers omit Origin on same-origin GETs, so only a foreign one is refused
    if (!same(headers['x-factory-token'], token)) return reply(403, { error: 'missing or wrong token' });
    if (headers.origin !== undefined && !hosts.some((h) => headers.origin === `http://${h}`)) return reply(403, { error: 'cross-origin request' });
    if (route === '/runs') return reply(200, { runs: runsData() });
    if (route === '/state') return reply(200, pageData({ resumable: resumable(), terminal: !!hostModules['node-pty'] })); // what page() embeds, for apps/web; never the token
    if (route === '/sessions') return reply(200, { sessions: listSessions() });
    if (route === '/metrics') { // #82: burn, outcomes and timing derived from the log; ?project=owner/repo&since=<ISO date>
      const q = (k) => u.searchParams.get(k) || undefined;
      if (q('since') && Number.isNaN(Date.parse(q('since')))) return reply(400, { error: 'since must be an ISO date like 2026-11-01' });
      try { const events = read(); return reply(200, logMetrics(events, { project: q('project'), since: q('since'), measured: measure(events), archive: readArchive() })); }
      catch (e) { console.error(`factory: /api/metrics: ${e.message}`); return reply(500, { error: 'metrics failed; see the F ui terminal' }); } // no internal message in the response
    }
    const ev = route.match(/^\/sessions\/([0-9a-f-]{36})\/events$/);
    if (ev) { // server-sent events; ui() writes the stream. EventSource can't send x-factory-token, so clients read it with fetch.
      const s = getSession(ev[1]);
      return s ? { status: 200, type: 'text/event-stream', stream: s, from: /^\d+$/.test(headers['last-event-id'] || '') ? Number(headers['last-event-id']) + 1 : 0 } : reply(404, { error: `no session ${ev[1]}` });
    }
    const m = route.match(/^\/runs\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!m) return reply(404, { error: 'not found' });
    const [, owner, repo, n] = m; // raw segments: the checks below admit no %-escapes
    if (!LOGIN.test(owner) || !/^[\w.-]{1,100}$/.test(repo) || !/^\d{1,9}$/.test(n)) return reply(400, { error: 'expected /api/runs/<owner>/<repo>/<issue number>' });
    const run = runsData().find((r) => r.id === `${owner}/${repo}#${n}`);
    return run ? reply(200, { run }) : reply(404, { error: `no run ${owner}/${repo}#${n}` });
  }
  if (method === 'POST' && Object.hasOwn(UI_ROUTES, route)) { // every write (and the onboarding read) passes the same checks
    if (!same(headers['x-factory-token'], token)) return reply(403, { error: 'missing or wrong token' });
    if (!hosts.some((h) => headers.origin === `http://${h}`)) return reply(403, { error: 'cross-origin request' });
    if (!/^application\/json\b/.test(headers['content-type'] || '')) return reply(415, { error: 'expected application/json' });
    try {
      const x = JSON.parse(body || '{}');
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('expected a JSON object');
      return reply(200, UI_ROUTES[route](x));
    } catch (e) { return reply(400, { error: e.message }); }
  }
  return reply(404, { error: 'not found' });
}
// Each route calls the same validated function as its CLI command.
export const UI_ROUTES = {
  '/skills': ({ scope, step, runner }) => { setSkill(scope, step, runner === null ? undefined : runner); return skillsData(runRepos()); },
  // applied/skipped/inherited say what changed: in a project a preset only touches the steps it already sets.
  '/skills/preset': ({ name, scope }) => { const { applied, skipped, inherited } = applyPreset(name, scope ?? 'default'); return { ...skillsData(runRepos()), applied, skipped, inherited }; },
  // Records the idea only: repo and issue creation stay in the Claude session, behind its checkpoints. Returns an id, never
  // the idea text, since `next` is pasted into a terminal.
  '/idea': ({ repo, idea, stack }) => { const p = startIdea({ repo, idea, stack }); return { run: p.id, next: `/software-factory new ${p.repo}` }; },
  // F note <run> next: the same validation (1-1000 characters, a run F builds, not finished) and the same audit record.
  '/note': ({ run, text }) => { if (typeof run !== 'string' || typeof text !== 'string') throw new Error('run and text must be strings'); return note(run, 'next', text); },
  '/onboard': () => onboardState(),
  '/onboard/sync': ({ repo, path: p }) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(path.join(p, '.git'))) throw new Error('path must be the absolute path of a local clone');
    sync(repo, p);
    return onboardConfig();
  },
  '/onboard/ship': ({ scope, ship }) => { setShip(scope, ship); return onboardConfig(); },
  '/onboard/rule': ({ scope, key, value, reason, until, unset }) => {
    if (typeof key !== 'string') throw new Error('key must be a string');
    if (unset) unsetRule(scope, key, { reason });
    else setRule(scope, key, typeof value === 'string' ? value : JSON.stringify(value), { reason, until: until || undefined });
    return onboardConfig();
  },
  '/onboard/automerge': ({ repo, on }) => { setAutoMerge(repo, on); return onboardConfig(); },
  '/sessions': (x) => ({ session: launchSession(x).id }),
  '/runs': ({ issue, harness }) => startRun(issue, process.env, spawn, harness),
  '/sessions/terminal': (x) => ({ session: terminalSession(x).id }),
  '/sessions/input': ({ id, data, cols, rows }) => { // keystrokes and size for a terminal session
    const s = getSession(id);
    if (!s?.write || s.state !== 'running') throw new Error('no running terminal session with that id');
    const size = cols !== undefined || rows !== undefined; // all checked before any is applied
    if (data !== undefined && (typeof data !== 'string' || data.length > 32768)) throw new Error('data must be a string up to 32 KB'); // JSON escaping can double it: the body cap is 64K
    if (size && ![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) throw new Error('cols and rows must be 1-1000');
    if (data !== undefined) s.write(data);
    if (size) s.resize(cols, rows);
    return { ok: true };
  },
  '/sessions/stop': ({ id }) => { const s = getSession(id); if (s?.state !== 'running') throw new Error('no running session with that id'); s.stop(); return { ok: true }; },
  '/sessions/open': (x) => openSession(x),
};
// POST /api/sessions: start the factory on one issue in an attached clone (#25's checks). The request names a repo and an
// issue only; the folder comes from projects() and the prompt is built here, so no request text reaches the harness.
export const harnessReady = new Map(); // harness id -> when detect() and login() last passed
// The harness session to resume for a run, or undefined. Only a run that is still active and that the stopped or crashed
// session last wrote: its last event falls inside that session's life. Anything else, such as a terminal /software-factory
// run that has owned the issue since, is refused as an active run.
const SESSION_ID = /^\w[\w-]{0,99}$/; // a harness session id as an argument: plain, and never a flag (no leading '-')
export function resumeFor(r, last) {
  if (!r || TERMINAL.includes(r.outcome) || !last || last.state === 'running' || last.exit === 0 || last.exit === 'unknown') return undefined; // unsure: no auto-resume
  const v = last.harnessSession;
  return covers(r, last) && SESSION_ID.test(v || '') ? v : undefined;
}
const covers = (r, x) => { // the run's last event falls inside x's life; its last lines land just after
  const at = Date.parse(r?.events?.at(-1)?.ts || 0);
  return at >= Date.parse(x.started) && at <= Date.parse(x.ended) + 5_000;
};
// The factory's own sessions: a person's terminal on the same run label never stands in for the run's last session.
const factorySessions = (label) => listSessions().filter((x) => x.mode !== 'terminal' && x.label === label);
// Runs a POST /api/sessions would resume now (#105): active, not closed or over budget, last written by a session here or an F
// start that stopped or crashed, and held by no live claim. GET /api/state polls it, so the cheap checks come first: a run
// with no session here and no F start log costs one readdir, a log is read once per change, and the claim (ps) comes last.
export function resumable() {
  const runs = derive(read()), archive = readArchive();
  return Object.keys(runs).filter((id) => { const r = runs[id];
    return !TERMINAL.includes(r.outcome) && !closedWhy(id, r, archive) && !budget(r).over && resumeOf(id, r) && !claimedElsewhere(id, {}); });
}
// A session of this app's is on that run (#107): the way out is to stop it here, not F unclaim.
const inApp = (label: string, s: { id: string; mode: string; started: string }) => new Error(`${label} already has a running session in this app (${s.mode}, started ${s.started}): stop it in Sessions first (POST /api/sessions/stop {"id":"${s.id}"})`);
const runningOn = (label: string) => listSessions().find((x) => x.state === 'running' && x.label === label);
// What the run may still spend: COST_CAP less the dollars, and less the share of TOKEN_CAP used, for usage with no price.
export const budgetLeft = (b) => b ? Math.min(COST_CAP - b.usd, COST_CAP * (1 - b.tokens / TOKEN_CAP)) : COST_CAP;
// node-pty and the SDK for terminal and sdk sessions, keyed by package name. Empty until a host that ships them (apps/desktop,
// main.ts) sets them: packages/adapters' lazy import() can't see apps/desktop's dependencies under pnpm (ADR 0001).
export const hostModules: Record<string, unknown> = {};
const checkRepo = (repo) => {
  const [owner, name, extra] = typeof repo === 'string' ? repo.split('/') : [];
  if (extra !== undefined || !LOGIN.test(owner || '') || !/^(?!\.\.?$)[\w.-]{1,100}$/.test(name || '')) throw new Error('repo must be owner/repo');
};
// A run id as F start, POST /api/runs and F unclaim take it: owner/repo#N, checked as launches check the repo and issue.
export function parseRun(x: unknown) {
  const m = /^([\w.-]+\/[\w.-]+)#(\d{1,10})$/.exec(typeof x === 'string' ? x : '');
  if (!m) throw new Error('issue must be owner/repo#N');
  checkRepo(m[1]);
  const issue = Number(m[2]);
  if (issue < 1 || issue > 1e9) throw new Error('issue must be a positive issue number');
  return { repo: m[1], issue, id: `${m[1]}#${issue}` };
}
const clone = (repo) => { // an attached repo's folder
  checkRepo(repo);
  const cwd = projects()[repo]?.path;
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`${repo} is not attached: F sync ${repo} <path> first`);
  return cwd;
};
// A person's own interactive harness in the desktop app's terminal pane (#58): no prompt and no budget, so never a factory
// run's session. In the run's worktree when it has one, else the clone. `resume` continues a session this app started, in
// that session's own folder: claude keeps its sessions per project folder, so elsewhere --resume wouldn't find it.
export function terminalSession({ harness = 'claude-code', repo, issue, resume }, env = process.env, modules = hostModules) {
  const h = harnesses.find((y) => y.id === harness);
  if (!h?.launch || !(h.modes || []).includes('terminal')) throw new Error(`harness ${String(harness).slice(0, 40)} has no terminal mode`);
  if (!modules['node-pty']) throw new Error('a terminal needs the desktop app, which supplies node-pty: run it in your own terminal');
  let cwd = clone(repo);
  if (issue !== undefined && (!Number.isInteger(issue) || issue < 1 || issue > 1e9)) throw new Error('issue must be a positive issue number');
  if (resume !== undefined && !SESSION_ID.test(String(resume))) throw new Error('resume must be a harness session id');
  const id = issue ? `${repo}#${issue}` : repo, wt = issue && wtInfo(id)?.path;
  if (wt && fs.existsSync(wt)) cwd = wt;
  // A new terminal on a run active with nothing to resume: a skill run in another claude (it holds no claim) may still be
  // working it, and this terminal's claim would refuse that harness's next step. Resuming this app's own session is fine.
  if (issue && resume === undefined) {
    const on = runningOn(id); // a factory session or another terminal here: two harnesses on one run (#105, #107)
    if (on) throw inApp(id, on);
    activeRun(id, derive(read())[id], `open the terminal on ${repo} instead, or wait until that run is done`);
  }
  let label = id;
  if (resume !== undefined) { // under the resumed session's own label, so launchSession's running check sees it
    const from = listSessions().filter((x) => x.harnessSession === resume && x.harness === h.id).at(-1);
    if (!from) throw new Error('resume a session this app started');
    const on = listSessions().find((x) => x.state === 'running' && (x.label === from.label || x.harnessSession === resume)); // one claude per harness session
    if (on) throw inApp(from.label, on);
    cwd = getSession(from.id).cwd ?? cwd; label = from.label;
  }
  const start = (onPid?: (pid: number) => void, claim?: string) => startSession(h, { mode: 'terminal', resume }, { cwd, env: withClaim(env, claim), label, modules, onPid });
  return label.includes('#') ? claimed(label, 'terminal', start) : start(); // on a run: no F start or other app alongside
}
// A run left active by a session that was stopped or crashed (here, or an F start whose process is gone) resumes that
// harness session instead of staying stuck; one active with nothing to resume refuses, saying what to do instead.
// Here and among F start's logs alike, newest first, the first session that is running, exited 0, or wrote r's last event:
// a later resume that died before its first event doesn't hide the one that wrote it (#105), and a clean exit since still
// refuses. The newer of the two.
// That session (its harness and harnessSession) when a start would resume it, else undefined.
function resumeOf(id: string, r): { harness: string; harnessSession: string } | undefined {
  const mine = factorySessions(id);
  const here = [...mine].reverse().find((x) => x.state === 'running' || x.exit === 0 || covers(r, x)) ?? mine.at(-1);
  const there = detachedRun(id, r), last = there && !(Date.parse(here?.started) > Date.parse(there.started)) ? there : here;
  return resumeFor(r, last) ? last : undefined;
}
// A start resumes on the harness that ran the session: a Claude session id never reaches codex, nor the other way round.
function activeRun(id: string, r, instead: string, harness?: string) {
  const last = resumeOf(id, r);
  if (r && !TERMINAL.includes(r.outcome) && !last) throw new Error(`${id} already has an active run (${r.outcome || r.stage}): its harness may still be working it (a skill run in another claude); ${instead}`);
  if (last && harness && last.harness !== harness) throw new Error(`${id} was left active by a ${last.harness} session: resume it on ${last.harness}, not ${harness}`);
  return last?.harnessSession;
}
// Why no start may take run r at all, for launchGate and resumable() alike.
function closedWhy(id: string, r, archive = readArchive()) {
  if (r?.imported) return `${id} is imported: never run claude -p in its checkout`;
  if (['escalated', 'rejected'].includes(r?.outcome)) return `${id} is ${r.outcome}: it needs a human, not a new run`; // the factory handed it over
  // F archive drops a run from the log, not from history: a stray later event (a sync, a step) doesn't reopen it. Only a new
  // intake does, which a person starts (/software-factory <id>), so that is the explicit reopen.
  const reopened = r?.events?.some((e) => e.stage === 'intake' && e.status === 'started');
  const gone = !reopened && archive.find((a) => a.id === id);
  return gone ? `${id} is ${gone.outcome} (archived): it needs a human, not a new run` : undefined;
}
// The checks every factory start passes (#25), for a live session here (launchSession) and a detached run (startRun).
// No harness named: the one a resume would continue on (so the dashboard's Resume agrees with resumable()), else claude-code.
function launchGate({ harness, mode = 'headless', repo, issue }: { harness?: string; mode?: string; repo?: unknown; issue?: unknown }, modules = hostModules) {
  if (harness === undefined) { const id = `${repo}#${issue}`, r = derive(read())[id]; harness = (r && resumeOf(id, r)?.harness) || 'claude-code'; } // a run's own id only: derive's keys
  const h = harnesses.find((y) => y.id === harness);
  if (!h?.launch) throw new Error(`harness ${String(harness).slice(0, 40)} cannot launch sessions`);
  if (!(h.modes || []).includes(mode)) throw new Error(`${h.id} modes are ${(h.modes || []).join(', ')}`);
  if (mode === 'terminal') throw new Error('factory runs are headless or sdk: a terminal session has no budget cap or pinned policy'); // a person drives terminal mode
  const need = mode === 'sdk' && h.launch({ mode, prompt: 'x' }).module;
  if (need && !modules[need]) throw new Error(`${mode} mode needs the desktop app, which supplies ${need}: run headless`);
  const cwd = clone(repo);
  if (!Number.isInteger(issue) || issue < 1 || issue > 1e9) throw new Error('issue must be a positive issue number');
  const id = `${repo}#${issue}`, r = derive(read())[id];
  const held = readClaim(id); // a stale one is taken over by the launcher's takeClaim(); a live one refuses, finished run or not
  const why = closedWhy(id, r);
  if (why) throw new Error(why);
  // Any running session on the run, a person's terminal included: two harnesses would share one session or worktree.
  const on = runningOn(id); // before its first event lands
  if (on) throw inApp(id, on);
  if (held && claimLive(held)) throw running(id, held); // another process's, or a harness this app left running
  const resume = activeRun(id, r, 'wait until that run is done', h.id);
  const b = r ? budget(r) : null;
  if (b?.over) throw new Error(`run budget exceeded ${budgetWhy(b)}`);
  if (!(Date.now() - (harnessReady.get(h.id) || 0) < 60_000)) { // spawnSync twice: once a minute, not per request
    const d = h.detect();
    if (!d.installed) throw new Error(`${h.label} is not installed: ${h.install}`);
    const l = h.login();
    if (!l.ok) throw new Error(`${h.label} is not signed in: ${l.hint}`);
    harnessReady.set(h.id, Date.now()); // only a success is cached, so a fresh sign-in counts at once
  }
  return { h, mode, cwd, id, resume, budget: budgetLeft(b) };
}
export function launchSession(x, env = process.env, modules = hostModules) {
  const { h, mode, cwd, id, resume, budget: left } = launchGate(x, modules);
  return claimed(id, 'session', (onPid, claim) => startSession(h, { mode, prompt: `/software-factory ${id}`, resume, budget: left, write: true }, { cwd, env: withClaim(env, claim), label: id, modules, onPid }));
}
// A session started here holds the run's claim until it exits, under its harness's pid and start time (the headless child,
// the pty, or the CLI the SDK spawns), so a harness this app leaves behind when killed still holds it. A failed start lets go at once;
// a pid whose start time can't be read (POSIX) is stopped, as the claim couldn't tell it from a reused pid later, and so is
// one whose claim was cleared (F unclaim --force) before it started.
// The harness gets the claim's token (FACTORY_CLAIM), so its own F intake and the like pass the claim it holds.
function claimed(id: string, launcher: string, start: (onPid: (pid: number) => void, claim: string) => Session) {
  const cl = takeClaim(id, launcher); // pid 0 until the spawn
  let s: Session | undefined, bad: Error | undefined;
  const onPid = (pid: number) => {
    try { cl.update({ pid, since: startTime(pid) }); } catch (e) { bad = e as Error; s?.stop(); }
  };
  try { s = start(onPid, cl.claim.token!); } catch (e) { cl.release(); throw e; }
  subscribe(s, (e) => { if (e.type === 'exit') cl.release(); });
  if (bad) { s.stop(); throw bad; } // a headless spawn reports its pid before start() returns
  return s;
}
const startTime = (pid: number) => {
  const since = procStart(pid);
  if (!since && process.platform !== 'win32') throw new Error(`could not read the start time of pid ${pid} (ps): stopped it`);
  return since;
};
type Session = { id: string; stop: () => void };
// The F start run a start on run r would look at, as resumeFor() reads a stopped session, from its log in the run's folder (not
// the claim, which a later launcher may have taken over). Of the newest 20 logs that name a harness session, newest first, the
// first that wrote r's last event (its life, from the time in its name to its last write, covers it) or that exited 0:
// a later start that died before writing doesn't hide the one that wrote it, and a clean exit since refuses.
// Its name ends .<harness>.log; a plain .log is claude-code's (written before codex could run).
const LOG = /^headless-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3}Z)(?:\.([a-z][a-z0-9-]{0,30}))?\.log$/;
function detachedRun(id: string, r) {
  let names: string[] = [];
  try { names = fs.readdirSync(runDir(id)).filter((f) => LOG.test(f)).sort().reverse().slice(0, 20); } catch { /* no folder */ }
  for (const n of names) {
    const [, d, mm, ss, ms, harness = 'claude-code'] = LOG.exec(n)!;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(runDir(id), n)); } catch { continue; } // gone meanwhile
    const x = { state: 'exited', harness, started: `${d}:${mm}:${ss}.${ms}`, ended: st.mtime.toISOString() }, seen = readLog(path.join(runDir(id), n), st, harness);
    if (seen?.harnessSession && (covers(r, x) || seen.exit === 0)) return { ...x, ...seen };
  }
  return undefined;
}
// One F start log's harness session and exit, as its harness reads its own events (sessionOf, exitOf): the first session id
// in the head; 0 when the last event is a clean end, null when it is any other event (killed), 'unknown' when the tail holds
// none or no harness of that id is loaded (unsure: never auto-resumed). An event is a JSON object with a string type: stderr
// shares the log, so a later line that isn't one, JSON or not, doesn't count. Read once per size and mtime.
const logs = new Map<string, { key: string; seen: { harnessSession?: string; exit: 0 | null | 'unknown' } }>();
function readLog(file: string, st: fs.Stats, harness: string) {
  const key = `${st.size}:${st.mtimeMs}`, hit = logs.get(file);
  if (hit?.key === key) return hit.seen;
  let head = '', tail = '';
  try {
    const fd = fs.openSync(file, 'r'), at = (n: number, from: number) => { const b = Buffer.alloc(Math.min(st.size, n)); return b.subarray(0, fs.readSync(fd, b, 0, b.length, from)).toString('utf8'); };
    try { head = at(64 * 1024, 0); tail = at(1024 * 1024, Math.max(0, st.size - 1024 * 1024)); } finally { fs.closeSync(fd); }
  } catch { return undefined; }
  const h = harnesses.find((y) => y.id === harness), event = (l: string) => { try { const e = JSON.parse(l); return e && typeof e === 'object' && typeof e.type === 'string' ? e : undefined; } catch { return undefined; } };
  let last, harnessSession;
  for (const l of tail.trimEnd().split('\n').reverse()) if ((last = event(l))) break; // shortcut: a last event over 1 MB is cut, so reads as unknown; read back to its start if that matters
  for (const l of head.split('\n')) { const e = event(l); if ((harnessSession = e && h?.sessionOf?.(e))) break; }
  const seen = { harnessSession, exit: !last || !h?.exitOf ? 'unknown' as const : h.exitOf(last) };
  logs.set(file, { key, seen });
  return seen;
}
// F start and POST /api/runs (#25): the factory on one issue as a detached headless harness that outlives F and F ui, with
// launchSession's checks. Not a session here: GET /api/sessions doesn't list it and quitting doesn't stop it. The prompt
// and output are files in the run's folder, so nothing waits on F. run is for tests (child_process.spawn's shape). harness:
// as launchGate's (none: the one a resume continues on, else claude-code); the log's name says which, for readLog.
export function startRun(issue, env = process.env, run = spawn, harness?: string) {
  const { h, cwd, id, resume, budget: left } = launchGate({ ...parseRun(issue), harness });
  const cl = takeClaim(id, 'start'); // before the spawn: a second launcher now waits on this claim, not on the run's first event
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.join(runDir(id), `headless-${stamp}.${h.id}.log`), prompt = path.join(runDir(id), `headless-${stamp}.${h.id}.prompt`);
  fs.mkdirSync(runDir(id), { recursive: true }); // the claim's folder is the id lowercased: on a case-sensitive disk, not this one
  let child;
  try {
    const spec = h.launch({ mode: 'headless', prompt: `/software-factory ${id}`, resume, budget: left, write: true }), c = resolveSpec(spec, env);
    fs.writeFileSync(prompt, spec.stdin ?? '');
    const stdin = fs.openSync(prompt, 'r'), out = fs.openSync(log, 'a');
    try {
      child = run(c.file, c.args, { cwd, env: withClaim(childEnv({ ...env, ...c.env }), cl.claim.token), stdio: [stdin, out, out], detached: true, windowsHide: true, windowsVerbatimArguments: !!c.windowsVerbatimArguments }); // the host's ids out, the claim's token in
      child.on('error', () => { /* no pid: refused below */ });
    } finally { fs.closeSync(stdin); fs.closeSync(out); }
    if (!child.pid) throw new Error(`${spec.cmd} did not start`);
    cl.update({ pid: child.pid, since: startTime(child.pid), log }); // an unreadable start time fails the start: the child is killed below
  } catch (e) { // nothing left behind: no claim, no empty log, no child the claim doesn't name
    if (child?.pid) killTree(child);
    cl.release();
    for (const f of [log, prompt]) try { fs.unlinkSync(f); } catch { /* not written */ }
    throw e;
  }
  child.unref();
  return { pid: child.pid, log };
}

// F open <session> and POST /api/sessions/open (#26): a session in the Claude desktop app on this machine when it has a
// desktop id, its own (local_<uuid>) or the one F recorded with a CLI session's events; else how to resume it, and where.
// Nothing here runs a shell: the opener gets one validated claude:// link, and the resume command is only shown. Opening a
// desktop session adds no harness; a resume does, so it is refused while a launcher holds a live (or unreadable) claim on a
// run that session worked on (its events, or this app's session label). A session with no recorded run can't be checked.
export function openSession({ harness = 'claude-code', id }: { harness?: string; id?: unknown }, opener: (url: string) => string = open) {
  const h = harnesses.find((y) => y.id === harness);
  if (!h) throw new Error(`no harness ${String(harness).slice(0, 40)}`);
  const sid = typeof id === 'string' ? id : '';
  if (!HOST_ID.test(sid) && !SESSION_ID.test(sid)) throw new Error('id must be a session id');
  const runs = Object.entries(derive(read())), mine = listSessions().find((x) => x.harnessSession === sid)?.label;
  const seen = runs.flatMap(([, r]) => r.sessions ?? []).filter((x) => x.id === sid && (!x.agent || x.agent === h.id))
    .sort((a, b) => (a.last ?? '').localeCompare(b.last ?? '')); // the latest last: one CLI session can drive several runs
  const url = h.openDesktop?.(HOST_ID.test(sid) ? sid : seen.map((x) => x.hostId).filter(Boolean).at(-1) ?? ''), cwd = seen.at(-1)?.cwd;
  if (url) return { opened: opener(url) };
  if (!h.modes?.includes('terminal')) throw new Error(`${h.id} has no desktop link or terminal resume for ${sid}`);
  for (const run of new Set([...runs.filter(([, r]) => r.sessions?.some((x) => x.id === sid)).map(([k]) => k), ...(mine?.includes('#') ? [mine] : [])])) {
    refuseClaimed(run, {}); // no token: any live claim, an unreadable one included (F unclaim --force), refuses
  }
  const spec = h.launch({ mode: 'terminal', resume: sid });
  return { resume: { command: [spec.cmd, ...spec.args].join(' '), ...(cwd && { cwd }) } }; // started outside the desktop app
}

// The F ui server, unprinted: the desktop main loads `url` in its window; F ui prints it. Resolves once listening.
export async function serve(port = 0) {
  await loadShipList(); // the wizard's ship step lists packages/ship's connectors
  const token = crypto.randomBytes(24).toString('base64url');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let r;
      try { r = uiHandle({ method: req.method, url: req.url, headers: req.headers, body }, { token, port: server.address().port }); } catch (e) { r = { status: 500, type: 'application/json', body: JSON.stringify({ error: e.message }) }; }
      res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...(r.location && { location: r.location }) });
      if (!r.stream) return res.end(r.body);
      let stop = () => {};
      res.on('close', () => stop()); // first, so a client gone mid-replay unsubscribes; not req: its close fires once the body is read
      stop = subscribe(r.stream, (e) => { if (res.destroyed) return; res.write(`${e.n === undefined ? '' : `id: ${e.n}\n`}data: ${JSON.stringify(e)}\n\n`); if (e.type === 'exit') res.end(); }, r.from);
      if (res.destroyed) stop();
      if (r.stream.state !== 'running') res.end();
    });
  });
  // close(): the desktop app's quit. Sessions run detached in their own process group, so they'd outlive it; stop them first.
  const close = () => { stopAll(); server.closeAllConnections(); server.close(); };
  return new Promise<{ server: http.Server; token: string; url: string; close: () => void }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject); // later errors are logged, not swallowed by a settled promise
      server.on('error', (e) => console.error(`factory ui: ${e.message}`));
      resolve({ server, token, url: `http://127.0.0.1:${server.address().port}/?t=${token}`, close });
    });
  });
}
export const ui = (port = 0) => serve(port).then(({ url }) => console.log(`factory ui: ${url}\nOnly this URL can change settings (skills.json, rules, projects). Ctrl-C to stop.`));
export const runRepos = () => [...new Set([...Object.keys(derive(read())), ...readArchive().map((a) => a.id)].map((id) => id.split(/[#:]/)[0]))];
export function render() {
  const out = path.join(stateDir(), 'dashboard.html');
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(out, page({ reload: 10_000 })); // never carries a ui token; reload: the file:// page re-reads itself, as the Artifact can't
  return out;
}
// Core calls this after every state change, once the event is written: a broken app.html must not fail the write (the
// skill would retry and record twice), so it warns and leaves the last dashboard.html. F render itself still throws.
dashboard.render = () => { try { return render(); } catch (e) { console.error(`factory: dashboard not updated: ${e.message}`); return undefined; } };
// The run list the dashboard embeds and GET /api/runs returns: live + archived, linked sessions, worktree path.
export function runsData(events = read()) {
  const live = Object.values(withMeasured(derive(events), events));
  const archived = readArchive().filter((a) => !live.some((r) => r.id === a.id));
  for (const a of archived) for (const c of a.children || []) { const child = live.find((r) => r.id === c); if (child) child.parent = a.id; }
  const runs = [...live, ...archived].sort((a, b) => b.updated.localeCompare(a.updated));
  let links = {};
  try { links = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')); } catch { /* no sync yet */ }
  for (const r of runs) if (links[r.id]) r.sessions = [...(r.sessions || []), ...links[r.id].filter((x) => !(r.sessions || []).some((y) => y.id === x.id))];
  for (const r of runs) { const w = wtInfo(r.id); if (w?.path) r.worktree = w.path; } // the dashboard's "Open in Claude" cwd
  // Notes leave F as the box shows them: pending ones, with no author login. Their events keep id, step and status for the
  // timeline's "note · pending|applied" rows, never the text or `by`, so an applied note's text stays in F's log.
  for (const r of runs) {
    if (r.notes) r.notes = r.notes.filter((n) => n.state === 'pending').map(({ by, ...n }) => n);
    r.events = (r.events || []).map((e) => e.stage === 'note' ? (({ text, by, ...x }) => x)(e) : e); // copies: derive() shares the log's objects
  }
  return runs;
}
// Everything the dashboard shows: runs, metrics, rules, skills, harnesses, hooks, ideas. page() embeds it; GET /api/state returns it.
export function pageData(extra = {}) {
  const events = read();
  const runs = runsData(events);
  const repoOf = (id) => id.split(/[#:]/)[0];
  const byProject = {};
  for (const p of new Set(runs.map((r) => repoOf(r.id)))) byProject[p] = metrics(runs.filter((r) => repoOf(r.id) === p));
  const ruleData = { rules: {}, ruleHistory: read().filter((e) => e.stage === 'rules').slice(-100) };
  try { const cfg = readSkills(); for (const p of new Set([...Object.keys(byProject), ...Object.keys(projects())])) ruleData.rules[p] = rules(p, cfg); }
  catch (e) { ruleData.rulesError = e.message; } // render runs after every record(): a bad config must not half-fail the event
  let idea = {};
  try { idea = { ideas: ideas(events, Object.fromEntries(runs.map((r) => [r.id, r]))) }; } catch (e) { idea = { ideasError: e.message }; } // never fail the event that triggered the render
  const F_CMD = fCmd(); // per page build, so installing the plugin while the app runs clears fMissing without a restart
  return { generated: new Date().toISOString(), cap: CAP, costCap: COST_CAP, tokenCap: TOKEN_CAP, projects: Object.keys(projects()), metrics: { all: metrics(runs), byProject }, runs, ...ruleData, skills: skillsData(Object.keys(byProject)),
    harnesses: harnesses.map(({ id, label, install }) => ({ id, label, install })), hooks: hooks(), onboard: readOnboard(), fCmd: F_CMD, ...(!F_CMD && { fMissing: true }),
    autoMerge: Object.fromEntries(Object.entries(projects()).map(([r, p]) => [r, p?.autoMerge !== false])), ...idea, ...extra };
}
export function page(extra = {}) {
  const data = JSON.stringify(pageData(extra)).replace(/</g, '\\u003c'), html = fs.readFileSync(APP_HTML, 'utf8');
  if (!DATA_TAG.test(html)) throw new Error(`${APP_HTML} has no data tag: rebuild it with pnpm --filter @software-factory/web dashboard`);
  return html.replace(DATA_TAG, (_, open, _old, close) => open + data + close);
}

// The claude.ai Artifact page (#18): the host adds the document skeleton, updates arrive by republish (no reload),
// no local path leaves this machine, and it refuses to ship a token. Throws when the dashboard markup drifts, so a
// broken page is never published.
// No local path leaves the machine: the keys that only hold one ("Open in Claude" cwds) go, and every string is
// scrubbed. A path starts at a local URL (file:///, vscode-remote://…), a UNC or WSL share, a drive letter, ~/, a known
// root (/Users, /home, …) or any /a/b, and runs to the next hard delimiter or URL, spaces included ("Application
// Support", "Bob Smith"): over-redacting prose is the safe side. Web URLs survive: their slashes follow a word
// character or '/'. Whatever the patterns miss, the residue check in artifact() refuses.
const PATH_ONLY = new Set(['worktree', 'cwd', 'installPath', 'projectPath', 'fCmd', 'hostId', 'hostSessionId']); // fCmd: the page falls back to the ~ form; hostId: a desktop session on this machine
const STOP = String.raw`\n\r"'\x60<>|(){}\[\];,&*?`;
const BODY = String.raw`(?:(?:(?!\s+https?:\/\/)[^${STOP}])*[^\s${STOP}])?`;
const ROOTS = 'Users|home|Volumes|srv|private|var|tmp|opt|mnt|media|root|usr|etc|Library|Applications|nix|workspaces?';
const LOCAL_PATH = new RegExp([
  String.raw`\b(?:[\w.+-]+:\/\/(?:\/|file\/)|(?:vscode|cursor|windsurf)[\w.+-]*:\/\/)[^\s"'\x60<>]*`, // file:///…, vscode://file/…, vscode-remote://…
  String.raw`(?<![\w\\])\\\\[\w.$-]+\\${BODY}`, // \\server\share…, \\wsl.localhost\…
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]${BODY}`, // C:\…, C:/…, D:\
  String.raw`(?<!\w)~[\\/]${BODY}`,
  String.raw`(?<!\w)\/(?:${ROOTS})(?![\w.-])${BODY}`, // also after ':' or '=' (PATH=/a:/Users/…, cwd:/Users/…)
  String.raw`(?<![\w.\/~-])\/(?!api\/)[^\s\/${STOP}]+\/${BODY}`, // any other path with 2+ segments (cwd:/data/x); "/factory approve" and /api/… routes stay
].join('|'), 'g');
const scrub = (v) => typeof v === 'string' ? v.replace(LOCAL_PATH, '[local path]')
  : Array.isArray(v) ? v.map(scrub)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !PATH_ONLY.has(k)).map(([k, x]) => [k, scrub(x)])) : v;
// The backstop: what identifies this machine must not be in the page at all, URLs included (http://host.local:5173,
// http://localhost:3000/Users/bob). Two exceptions keep it from refusing every page: the login counts only as a path
// segment outside GitHub URLs and owner/repo ids (the owner, and a profile repo login/login, is often the login), and a
// short host name counts only as a host (host.local, user@host, \\host, //host[:port]), since "build" or "app" is prose.
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const machine = () => ({ user: os.userInfo().username, host: os.hostname(), home: os.homedir(), projects: projects() });
export function residue(json, raw, me = machine()) {
  const jsonOf = (x) => JSON.stringify(x).slice(1, -1), runs = raw.runs || [], left = [];
  const paths = [me.home, ...Object.values(me.projects).map((p) => p?.path), ...runs.flatMap((r) => [r.worktree, ...(r.sessions || []).map((s) => s.cwd)])];
  if (paths.some((p) => typeof p === 'string' && p.length > 3 && json.includes(jsonOf(p)))) left.push('a home, clone or worktree path');
  const ids = new Set([...Object.keys(me.projects), ...runs.map((r) => String(r.id).split(/[#:]/)[0])]);
  let text = json.replace(/(?:https?:\/\/)?(?:www\.)?github\.com[/:][^\s"\\,]*/gi, ''); // JSON text: \n is two characters, so stop at '\' too
  for (const id of ids) text = text.replace(new RegExp(String.raw`(?<![\w.\/\\-])${esc(id)}(?![\w.-])`, 'g'), '');
  if (me.user.length >= 3 && new RegExp(String.raw`(?:\\\\|\/)${esc(me.user)}(?![\w.-])`, 'i').test(text)) left.push('the login name in a path');
  const short = me.host.split('.')[0], hosts = [];
  if (me.host.includes('.') && me.host.length >= 3) hosts.push(String.raw`(?<![\w-])${esc(me.host)}(?![\w-])`);
  if (short.length >= 3) hosts.push(String.raw`(?<![\w-])${esc(short)}(?=\.local\b)`, String.raw`(?:(?<=[\w.-])[@＠]|\\\\\\\\|\/\/)${esc(short)}(?![\w.-])`); // user@host, not @scope/pkg
  if (hosts.length && new RegExp(hosts.join('|'), 'i').test(json)) left.push('the host name');
  return left;
}
const DATA_TAG = /(<script type="application\/json" id="data">)([^<]*)(<\/script>)/;
// GitHub, Anthropic and OpenAI key shapes, and an F ui URL with its token.
export const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|sk-(?:ant-)?[\w-]{30,})|127\.0\.0\.1:\d+\/?\?t=[\w-]{20,}/;
export function artifact(html = page()) {
  // Opening tags and metas come before the inlined script, so their first match is the tag; closing tags come after it, so their last.
  for (const [re, last] of [[/^<!doctype html>\s*/i], [/<html[^>]*>\s*/i], [/<head>\s*/i], [/<meta charset="utf-8">\s*/i], [/<meta name="viewport"[^>]*>\s*/i],
    [/<\/head>\s*/i], [/<body[^>]*>\s*/i], [/<\/body>\s*/gi, true], [/<\/html>\s*/gi, true]]) {
    const hits = [...html.matchAll(new RegExp(re.source, 'gi'))], m = last ? hits.at(-1) : hits[0];
    if (!m) throw new Error(`artifact: the dashboard no longer has ${re}`);
    html = html.slice(0, m.index) + html.slice(m.index + m[0].length);
  }
  const m = html.match(DATA_TAG);
  if (!m) throw new Error('artifact: the dashboard no longer has its data tag');
  const raw = JSON.parse(m[2]), d = scrub(raw);
  if (d.ui) throw new Error('artifact: refusing to publish a page built for F ui');
  delete d.reload; // updates arrive by republish
  if (d.skills?.catalog) d.skills.catalog = { global: [], projects: {} }; // install paths; the Skills sheet can't save there anyway
  const json = JSON.stringify(d), left = residue(json, raw);
  if (left.length) throw new Error(`artifact: refusing to publish: after scrubbing, the page still carries ${left.join(', ')}`);
  if (/"[^"]*token"\s*:/i.test(json)) throw new Error('artifact: refusing to publish a page that carries a token'); // a key ending in token; tokens/tokenCap are counts
  // The bundle itself (anyone can rebuild and commit app.html): the same residue check, and no credential-shaped value anywhere.
  const shell = html.replace(DATA_TAG, (_, open, _old, close) => open + close), inShell = residue(shell, raw);
  if (inShell.length) throw new Error(`artifact: refusing to publish: the app itself carries ${inShell.join(', ')}`);
  if (SECRET.test(shell) || SECRET.test(json)) throw new Error('artifact: refusing to publish a page that carries a token');
  return html.replace(DATA_TAG, (_, open, _old, close) => open + json.replace(/</g, '\\u003c') + close);
}
