// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CAP, COST_CAP, TOKEN_CAP } from '../../core/src/constants.ts';
import { hooks } from '../../core/src/ship.ts';
import { LOGIN, rules, setAutoMerge, setRule, unsetRule } from '../../core/src/rules.ts';
import { derive } from '../../core/src/derive.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { ideas, startIdea } from '../../core/src/project.ts';
import { metrics } from '../../core/src/gate.ts';
import { onboardConfig, onboardState, readOnboard, setShip } from '../../core/src/onboard.ts';
import { projects, wtInfo } from '../../core/src/workspace.ts';
import { dashboard, read, readArchive, sessionsFile, stateDir } from '../../core/src/log.ts';
import { readSkills, setSkill, skillsData } from '../../core/src/skills.ts';
import { sync } from '../../core/src/sync.ts';
import { withMeasured } from '../../core/src/burn.ts';

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
};
export function ui(port = 0) {
  const token = crypto.randomBytes(24).toString('base64url');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let r;
      try { r = uiHandle({ method: req.method, url: req.url, headers: req.headers, body }, { token, port: server.address().port }); } catch (e) { r = { status: 500, type: 'application/json', body: JSON.stringify({ error: e.message }) }; }
      res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
      res.end(r.body);
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

// The claude.ai Artifact page (#18): the host adds the document skeleton, updates arrive by republish (no reload timer),
// no local path leaves this machine, and it refuses to ship a token. Throws when the dashboard markup drifts, so a
// broken page is never published.
const DATA_TAG = /(<script type="application\/json" id="data">)([^<]*)(<\/script>)/;
export function artifact(html = page()) {
  for (const re of [/^<!doctype html>\s*/i, /<html[^>]*>\s*/i, /<head>\s*/i, /<\/head>\s*/i, /<body[^>]*>\s*/i, /<\/body>\s*/i, /<\/html>\s*/i,
    /<meta charset="utf-8">\s*/i, /<meta name="viewport"[^>]*>\s*/i]) {
    if (!re.test(html)) throw new Error(`artifact: the dashboard no longer has ${re}`);
    html = html.replace(re, '');
  }
  const reload = 'setTimeout(tick, 10000);';
  if (html.split(reload).length !== 2) throw new Error('artifact: the reload timer is not in the dashboard exactly once');
  html = html.replace(reload, '/* Artifact: updates arrive by republish, so no reload timer. */');
  const m = html.match(DATA_TAG);
  if (!m) throw new Error('artifact: the dashboard no longer has its data tag');
  const d = JSON.parse(m[2]);
  for (const r of d.runs || []) { delete r.worktree; for (const s of r.sessions || []) delete s.cwd; } // "Open in Claude" is local-only
  if (d.skills?.catalog) d.skills.catalog = { global: [], projects: {} }; // install paths; the Skills sheet can't save there anyway
  const home = JSON.stringify(os.homedir()).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let json = JSON.stringify(d);
  if (home.length > 1) json = json.replace(new RegExp(home + '(?=[/\\\\"]|$)', 'g'), '~'); // any path left in free text
  html = html.replace(DATA_TAG, (_, open, _old, close) => open + json.replace(/</g, '\\u003c') + close);
  if (html.includes('"token":"')) throw new Error('artifact: refusing to publish a page that carries a token');
  return html;
}
