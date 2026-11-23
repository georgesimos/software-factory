// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CAP, COST_CAP, TERMINAL, TOKEN_CAP } from '../../core/src/constants.ts';
import { hooks } from '../../core/src/ship.ts';
import { LOGIN, rules, setAutoMerge, setRule, unsetRule } from '../../core/src/rules.ts';
import { budget, budgetWhy, derive } from '../../core/src/derive.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { ideas, startIdea } from '../../core/src/project.ts';
import { metrics } from '../../core/src/gate.ts';
import { onboardConfig, onboardState, readOnboard, setShip } from '../../core/src/onboard.ts';
import { projects, wtInfo } from '../../core/src/workspace.ts';
import { dashboard, read, readArchive, sessionsFile, stateDir } from '../../core/src/log.ts';
import { readSkills, setSkill, skillsData } from '../../core/src/skills.ts';
import { sync } from '../../core/src/sync.ts';
import { withMeasured } from '../../core/src/burn.ts';
import { open } from '../../core/src/platform.ts';
import { getSession, listSessions, startSession, subscribe } from '../../adapters/sessions.mjs';

// `F ui`: the dashboard on a loopback port, where the Skills sheet can save. Pure, so the self-test can drive it.
export const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function uiHandle({ method, url, headers = {}, body = '' }, { token, port }) {
  const reply = (status, x) => ({ status, type: 'application/json', body: JSON.stringify(x) });
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(headers.host)) return reply(403, { error: 'unexpected Host header' }); // DNS rebinding
  const u = new URL(url, 'http://local');
  if (method === 'GET' && u.pathname === '/') {
    if (!same(u.searchParams.get('t'), token)) return reply(403, { error: 'open the URL that `F ui` printed' });
    return { status: 200, type: 'text/html; charset=utf-8', body: page({ ui: { token } }) };
  }
  const route = u.pathname.startsWith('/api/') ? u.pathname.slice(4) : u.pathname; // /api/<p> and the original <p> are one route
  if (method === 'GET' && u.pathname.startsWith('/api/')) { // reads: same token; browsers omit Origin on same-origin GETs, so only a foreign one is refused
    if (!same(headers['x-factory-token'], token)) return reply(403, { error: 'missing or wrong token' });
    if (headers.origin !== undefined && !hosts.some((h) => headers.origin === `http://${h}`)) return reply(403, { error: 'cross-origin request' });
    if (route === '/runs') return reply(200, { runs: runsData() });
    if (route === '/sessions') return reply(200, { sessions: listSessions() });
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
  // Records the idea only: repo and issue creation stay in the Claude session, behind its checkpoints. Returns an id, never
  // the idea text, since `next` is pasted into a terminal.
  '/idea': ({ repo, idea, stack }) => { const p = startIdea({ repo, idea, stack }); return { run: p.id, next: `/software-factory new ${p.repo}` }; },
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
  '/sessions/input': ({ id, data, cols, rows }) => { // keystrokes and size for a terminal session
    const s = getSession(id);
    if (!s?.write || s.state !== 'running') throw new Error('no running terminal session with that id');
    const size = cols !== undefined || rows !== undefined; // all checked before any is applied
    if (data !== undefined && (typeof data !== 'string' || data.length > 65536)) throw new Error('data must be a string up to 64 KB');
    if (size && ![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) throw new Error('cols and rows must be 1-1000');
    if (data !== undefined) s.write(data);
    if (size) s.resize(cols, rows);
    return { ok: true };
  },
  '/sessions/stop': ({ id }) => { const s = getSession(id); if (s?.state !== 'running') throw new Error('no running session with that id'); s.stop(); return { ok: true }; },
  '/sessions/open': ({ harness = 'claude-code', id }) => { // the desktop app's own link for a session, when the harness has one
    const h = harnesses.find((y) => y.id === harness), url = h?.openDesktop?.(id);
    if (!url) throw new Error(`no desktop link for ${String(id).slice(0, 60)}: run claude --resume <id> in a terminal instead`);
    return { opened: open(url) };
  },
};
// POST /api/sessions: start the factory on one issue in an attached clone (#25's checks). The request names a repo and an
// issue only; the folder comes from projects() and the prompt is built here, so no request text reaches the harness.
export const harnessReady = new Map(); // harness id -> when detect() and login() last passed
// The harness session to resume for a run, or undefined. Only a run that is still active and that the stopped or crashed
// session last wrote: its last event falls inside that session's life. Anything else, such as a terminal /software-factory
// run that has owned the issue since, is refused as an active run.
export function resumeFor(r, last) {
  if (!r || TERMINAL.includes(r.outcome) || !last || last.state === 'running' || last.exit === 0) return undefined;
  const at = Date.parse(r.events.at(-1)?.ts || 0), from = Date.parse(last.started), to = Date.parse(last.ended) + 5_000; // its last lines land just after
  const v = last.harnessSession;
  return at >= from && at <= to && /^[\w-]{1,100}$/.test(v || '') ? v : undefined; // plain: it becomes an argument
}
// What the run may still spend: COST_CAP less the dollars, and less the share of TOKEN_CAP used, for usage with no price.
export const budgetLeft = (b) => b ? Math.min(COST_CAP - b.usd, COST_CAP * (1 - b.tokens / TOKEN_CAP)) : COST_CAP;
// node-pty and the SDK for terminal and sdk sessions, keyed by package name. A host that ships them (the desktop app) must set
// them: packages/adapters' lazy import() can't see apps/desktop's dependencies under pnpm (ADR 0001).
export const hostModules = {};
export function launchSession({ harness = 'claude-code', mode = 'headless', repo, issue }, env = process.env, modules = hostModules) {

  const h = harnesses.find((y) => y.id === harness);
  if (!h?.launch) throw new Error(`harness ${String(harness).slice(0, 40)} cannot launch sessions`);
  if (!(h.modes || []).includes(mode)) throw new Error(`${h.id} modes are ${(h.modes || []).join(', ')}`);
  if (mode === 'terminal') throw new Error('factory runs are headless or sdk: a terminal session has no budget cap or pinned policy'); // a person drives terminal mode
  const [owner, name, extra] = typeof repo === 'string' ? repo.split('/') : [];
  if (extra !== undefined || !LOGIN.test(owner || '') || !/^(?!\.\.?$)[\w.-]{1,100}$/.test(name || '')) throw new Error('repo must be owner/repo');
  const cwd = projects()[repo]?.path;
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`${repo} is not attached: F sync ${repo} <path> first`);
  if (!Number.isInteger(issue) || issue < 1 || issue > 1e9) throw new Error('issue must be a positive issue number');
  const id = `${repo}#${issue}`, r = derive(read())[id];
  if (r?.imported) throw new Error(`${id} is imported: never run claude -p in its checkout`);
  const mine = listSessions().filter((x) => x.label === id);
  if (mine.some((x) => x.state === 'running')) throw new Error(`${id} already has a running session`); // before its first event lands
  // A run left active by a session that was stopped or crashed here resumes that harness session instead of staying stuck.
  const resume = resumeFor(r, mine.at(-1));
  if (r && !TERMINAL.includes(r.outcome) && !resume) throw new Error(`${id} already has an active run (${r.outcome || r.stage})`);
  const b = r ? budget(r) : null;
  if (b?.over) throw new Error(`run budget exceeded ${budgetWhy(b)}`);
  if (!(Date.now() - (harnessReady.get(h.id) || 0) < 60_000)) { // spawnSync twice: once a minute, not per request
    const d = h.detect();
    if (!d.installed) throw new Error(`${h.label} is not installed: ${h.install}`);
    const l = h.login();
    if (!l.ok) throw new Error(`${h.label} is not signed in: ${l.hint}`);
    harnessReady.set(h.id, Date.now()); // only a success is cached, so a fresh sign-in counts at once
  }
  return startSession(h, { mode, prompt: `/software-factory ${id}`, resume, budget: budgetLeft(b), write: true }, { cwd, env, label: id, modules });
}

export function ui(port = 0) {
  const token = crypto.randomBytes(24).toString('base64url');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let r;
      try { r = uiHandle({ method: req.method, url: req.url, headers: req.headers, body }, { token, port: server.address().port }); } catch (e) { r = { status: 500, type: 'application/json', body: JSON.stringify({ error: e.message }) }; }
      res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
      if (!r.stream) return res.end(r.body);
      let stop = () => {};
      res.on('close', () => stop()); // first, so a client gone mid-replay unsubscribes; not req: its close fires once the body is read
      stop = subscribe(r.stream, (e) => { if (res.destroyed) return; res.write(`${e.n === undefined ? '' : `id: ${e.n}\n`}data: ${JSON.stringify(e)}\n\n`); if (e.type === 'exit') res.end(); }, r.from);
      if (res.destroyed) stop();
      if (r.stream.state !== 'running') res.end();
    });
  });
  server.listen(port, '127.0.0.1', () => console.log(`factory ui: http://127.0.0.1:${server.address().port}/?t=${token}\nOnly this URL can change settings (skills.json, rules, projects). Ctrl-C to stop.`));
  return server;
}
export const runRepos = () => [...new Set([...Object.keys(derive(read())), ...readArchive().map((a) => a.id)].map((id) => id.split(/[#:]/)[0]))];
export function render() {
  const out = path.join(stateDir(), 'dashboard.html');
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(out, page()); // never carries a ui token: that exists only in what `F ui` serves
  return out;
}
dashboard.render = render; // core calls dashboard.render() after every state change
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
  return runs;
}
export function page(extra = {}) {
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
  const data = JSON.stringify({ generated: new Date().toISOString(), cap: CAP, costCap: COST_CAP, tokenCap: TOKEN_CAP, projects: Object.keys(projects()), metrics: { all: metrics(runs), byProject }, runs, ...ruleData, skills: skillsData(Object.keys(byProject)),
    harnesses: harnesses.map(({ id, label, install }) => ({ id, label, install })), hooks: hooks(), onboard: readOnboard(), ...idea, ...extra }).replace(/</g, '\\u003c');
  return fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'factory', 'dashboard.html'), 'utf8').replace('__FACTORY_DATA__', () => data);
}
