// H1: the harness launch contract, the session runner and /api/sessions, against test/bin's claude stub only.
// test/bin goes first on PATH and nothing else that could hold a real `claude`: a real one would start a paid run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { COST_CAP, TOKEN_CAP } from '../../core/src/constants.ts';
import { HERE } from '../factory.mjs';
import { archive, record } from '../../core/src/log.ts';
import { projects, saveProject, wtFile } from '../../core/src/workspace.ts';
import { command, opener } from '../../core/src/platform.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { MAX_BYTES, killTree, listSessions, resolveSpec, startSession, subscribe, getSession } from '../../adapters/sessions.mjs';
import { budgetLeft, harnessReady, launchSession, resumable, resumeFor, serve, terminalSession, uiHandle } from '../../server/src/server.ts';

setup();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-shome-'));
const stubEnv = { ...process.env, PATH: [path.join(HERE, 'test', 'bin'), path.dirname(process.execPath)].join(path.delimiter), HOME: home, USERPROFILE: home };
Object.assign(process.env, { PATH: stubEnv.PATH, HOME: home, USERPROFILE: home }); // detect() and login() spawn from this process's PATH
const claude = harnesses.find((h) => h.id === 'claude-code');
const finished = (s) => new Promise((resolve) => { const ev = []; subscribe(s, (e) => { ev.push(e); if (e.type === 'exit') resolve(ev); }); });
const LOCAL = 'local_0123abcd-0123-4567-89ab-0123456789ab';

test('claude-code launch(): headless pins stream-json --verbose with the prompt on stdin; terminal is plain claude; sdk gets the same policy as options', () => {
  const h = claude.launch({ mode: 'headless', prompt: '/software-factory acme/app#3', budget: 4.5, write: true });
  assert.equal(h.cmd, 'claude');
  assert.equal(h.args[0], '-p');
  assert.equal(h.stdin, '/software-factory acme/app#3');
  assert.ok(!h.args.includes(h.stdin), 'the prompt is not an argument');
  assert.ok(h.args.join(' ').includes('--output-format stream-json --verbose'));
  assert.deepEqual([h.args[h.args.indexOf('--permission-mode') + 1], h.args[h.args.indexOf('--max-budget-usd') + 1]], ['auto', '4.5']);
  assert.deepEqual(claude.launch({ mode: 'headless', prompt: 'x', resume: 'abc' }).args.slice(0, 2), ['--resume', 'abc']);
  assert.deepEqual(claude.launch({ mode: 'terminal', resume: 'abc' }), { cmd: 'claude', args: ['--resume', 'abc'] });
  assert.throws(() => claude.launch({ mode: 'terminal', prompt: 'fix #3' }), /takes no prompt/, 'never a prompt in argv: a .cmd shim could not pass it');
  assert.throws(() => claude.launch({ mode: 'headless' }), /needs a prompt/);
  const sd = claude.launch({ mode: 'sdk', prompt: 'x', budget: 2 });
  assert.deepEqual([sd.module, sd.prompt, sd.options.permissionMode, sd.options.maxBudgetUsd, sd.options.strictMcpConfig], ['@anthropic-ai/claude-agent-sdk', 'x', 'default', 2, true], 'read-only: the CLI\'s manual mode');
  assert.deepEqual([claude.launch({ mode: 'sdk', prompt: 'x', write: true }).options.permissionMode, claude.launch({ mode: 'sdk', prompt: 'x', write: true }).options.allowedTools], ['auto', undefined]);
  assert.equal(sd.options.permissionPrompts, 'none', 'no prompt can stall an sdk run');
  assert.throws(() => claude.launch({ mode: 'sdk' }), /needs a prompt/);
  assert.throws(() => startSession(claude, { mode: 'terminal', budget: 3 }, { cwd: home }), /no budget cap/);
  assert.throws(() => claude.launch({ mode: 'nope', prompt: 'x' }), /no nope mode/);
  assert.ok(claude.headlessArgs().includes('json') && !claude.headlessArgs().includes('stream-json'), 'F headless-args is unchanged');
});

// The sdk options are checked against the installed SDK's types: an option it doesn't declare would be dropped silently.
test('the sdk launch options are ones the installed Agent SDK declares', (t) => {
  const root = path.join(HERE, '..', '..', 'node_modules', '.pnpm');
  const dir = fs.existsSync(root) && fs.readdirSync(root).find((d) => d.startsWith('@anthropic-ai+claude-agent-sdk@'));
  if (!dir) return t.skip('the Agent SDK is not installed here');
  const dts = fs.readFileSync(path.join(root, dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts'), 'utf8');
  const modes = /export declare type PermissionMode = ([^;]+);/.exec(dts)[1];
  for (const write of [false, true]) {
    const { options } = claude.launch({ mode: 'sdk', prompt: 'x', budget: 2, resume: 'abc', write });
    for (const k of Object.keys(options)) assert.match(dts, new RegExp(`\\n\\s+${k}\\?:`), `Options.${k}`);
    assert.ok(modes.includes(`'${options.permissionMode}'`), options.permissionMode);
  }
  assert.match(dts, /permissionPrompts\?: 'host' \| 'none';/);
});

test('Windows: a headless launch runs through npm\'s claude.cmd, because the prompt (space, #) goes on stdin', () => {
  const win = { platform: 'win32', env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, isFile: (p) => p.toLowerCase() === 'c:\\npm\\claude.cmd' };
  const h = claude.launch({ mode: 'headless', prompt: '/software-factory acme/app#3', budget: 4.5, write: true, resume: '0123abcd-0123-4567-89ab-0123456789ab' });
  const c = command(h.cmd, h.args, win);
  assert.equal(c.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.match(c.args[3], /^""C:\\npm\\claude\.cmd" --resume 0123abcd-\S+ -p --output-format stream-json --verbose /);
  assert.throws(() => command(h.cmd, ['-p', h.stdin, ...h.args.slice(1)], win), /cmd\.exe quoting/, 'as an argument it would be refused');
});

test('openDesktop(): only a desktop session id gets the link, and opener() takes that one claude: URL only', () => {
  assert.equal(claude.openDesktop(LOCAL), `claude://claude.ai/epitaxy/${LOCAL}`);
  for (const bad of ['local_x', '0123abcd-0123-4567-89ab-0123456789ab', `${LOCAL}/../x`, `${LOCAL}?q=1`, undefined]) assert.equal(claude.openDesktop(bad), null, String(bad));
  assert.deepEqual(opener(`claude://claude.ai/epitaxy/${LOCAL}`, 'darwin').args, [`claude://claude.ai/epitaxy/${LOCAL}`]);
  for (const bad of ['claude://claude.ai/settings', `claude://claude.ai/epitaxy/${LOCAL}x`, `claude://evil.test/epitaxy/${LOCAL}`]) assert.throws(() => opener(bad, 'darwin'), /refusing/, bad);
});

test('startSession() runs a headless launch and streams NDJSON events, text, stderr and the exit', async () => {
  const s = startSession(claude, { mode: 'headless', prompt: 'hello there' }, { cwd: home, env: stubEnv, label: 't' });
  const ev = await finished(s);
  assert.equal(ev.find((e) => e.data?.subtype === 'init').data.session_id, 'stub-session');
  assert.equal(ev.find((e) => e.data?.type === 'assistant').data.message.content[0].text, 'prompt: hello there');
  assert.ok(ev.some((e) => e.type === 'text' && e.data === 'not json'));
  assert.ok(ev.some((e) => e.type === 'stderr' && e.data === 'a warning'));
  assert.deepEqual(ev.at(-1), { ...ev.at(-1), type: 'exit', code: 0 });
  assert.deepEqual(ev.map((e) => e.n), ev.map((_, i) => i), 'events are numbered in order');
  const late = []; subscribe(s, (e) => late.push(e), 3); // a reconnect replays from Last-Event-ID + 1
  assert.deepEqual(late.map((e) => e.n), ev.slice(3).map((e) => e.n));
  const sub = []; subscribe({ events: [{ n: 7 }, { n: 8 }], state: 'exited', listeners: new Set() }, (e) => sub.push(e), 2);
  assert.deepEqual(sub, [{ type: 'dropped', from: 2, first: 7 }, { n: 7 }, { n: 8 }], 'a replay past the buffer says what was lost');
  const none = startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env: { ...stubEnv, PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'factory-nobin-')) } });
  assert.match((await finished(none)).find((e) => e.type === 'error').message, /claude is not installed/);
});

test('a session killed by a signal ends: exit carries the signal, and stop() is safe before, during and after', async () => {
  const s = startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env: { ...stubEnv, STUB_HANG: '1' }, label: 'hang' });
  await new Promise((r) => { const off = subscribe(s, (e) => { if (e.data?.subtype === 'init') { off(); r(); } }); });
  const end = finished(s);
  s.stop();
  const ev = await end;
  assert.deepEqual([ev.at(-1).type, ev.at(-1).code, s.state, s.exit], ['exit', 'SIGTERM', 'exited', 'SIGTERM']);
  s.stop(); // already exited: a no-op
  const refused = startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env: { ...stubEnv, PATH: '' } });
  refused.stop(); // before its ENOENT lands: without the pid guard this signals the test runner's own process group
  assert.match((await finished(refused)).find((e) => e.type === 'error').message, /not installed/);
});

test('Windows: stop() ends the whole tree with taskkill, since kill() would end only cmd.exe; never pid 0', () => {
  const calls = [], run = (...a) => { calls.push(a.slice(0, 2)); return { on: () => {} }; }, groups = [], kill = (pid, sig) => { groups.push([pid, sig]); };
  let killed = 0; const child = { pid: 4242, kill: () => { killed++; } };
  killTree(child, 'win32', run, kill);
  assert.deepEqual([calls, killed], [[['taskkill', ['/pid', '4242', '/T', '/F']]], 0]);
  killTree(child, 'darwin', run, kill);
  assert.deepEqual(groups, [[-4242, 'SIGTERM']], 'POSIX: the whole process group');
  killTree(child, 'linux', run, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  killTree({ pid: 0, kill: () => { killed += 10; } }, 'darwin', run, kill); killTree({ pid: 0 }, 'win32', run, kill);
  assert.deepEqual([calls.length, groups.length, killed], [1, 1, 1], 'never pid 0; the child alone when its group is gone');
  const waited = []; // quit: spawnSync's shape (no .on), bounded so quit can't hang
  killTree(child, 'win32', (...a) => { waited.push(a); return { status: 0 }; }, kill, true);
  assert.deepEqual(waited, [['taskkill', ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }]]);
});

test('the command is found on the PATH and PATHEXT the session gets, not this process\'s', () => {
  const env = { PATH: 'D:\\tools', PATHEXT: '.EXE' }, resolve = { platform: 'win32', isFile: (p) => p.toLowerCase() === 'd:\\tools\\claude.exe' };
  assert.equal(resolveSpec({ cmd: 'claude', args: ['-p'] }, env, resolve).file, 'D:\\tools\\claude.exe');
  assert.equal(resolveSpec({ cmd: 'claude', args: ['-p'] }, { PATH: 'C:\\other' }, resolve).file, 'claude', 'not found there: left for ENOENT');
});

test('a session keeps at most MAX_BYTES of events and says what it dropped', async () => {
  const s = startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env: { ...stubEnv, STUB_BIG: '80' }, label: 'big' }); // ~5 MB
  await finished(s);
  assert.ok(s.events.reduce((n, e) => n + JSON.stringify(e).length, 0) <= MAX_BYTES);
  assert.ok(s.events[0].n > 0 && s.events.at(-1).type === 'exit');
  const sub = []; subscribe(s, (e) => sub.push(e), 0);
  assert.deepEqual(sub[0], { type: 'dropped', from: 0, first: s.events[0].n });
  assert.equal(s.harnessSession, 'stub-session', 'the harness session id outlives its dropped init event');
});

test('launchSession(): an attached repo and an issue number only; #25\'s refusals', async () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sclone-'));
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 3 }), /not attached/);
  saveProject('acme/app', clone);
  for (const [x, re] of [[{ repo: 'acme/app', issue: '3' }, /positive issue number/], [{ repo: 'acme/app', issue: 0 }, /positive issue number/], [{ repo: '../x', issue: 3 }, /owner\/repo/],
    [{ repo: 'acme/app', issue: 3, mode: 'nope' }, /modes are headless, terminal, sdk/], [{ repo: 'acme/app', issue: 3, harness: 'codex' }, /cannot launch/], [{ repo: 'acme/app', issue: 3, harness: 'nope' }, /cannot launch/]]) {
    assert.throws(() => launchSession(x), re, JSON.stringify(x));
  }
  record('acme/app#4', 'intake', 'started', {});
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 4 }), /already has an active run/);
  for (const [n, o] of [[80, 'escalated'], [81, 'rejected']]) {
    record(`acme/app#${n}`, 'approve', o, {});
    assert.throws(() => launchSession({ repo: 'acme/app', issue: n }), new RegExp(`is ${o}: it needs a human`));
  }
  assert.ok(archive(-1).archived >= 2, 'F archive moves the finished runs out of the log');
  for (const [n, o] of [[80, 'escalated'], [81, 'rejected']])
    assert.throws(() => launchSession({ repo: 'acme/app', issue: n }), new RegExp(`is ${o} \\(archived\\): it needs a human`), 'an archived run is still a human\'s call');
  record('acme/app#80', 'spec', 'started', {}); // a stray event after the archive: a live run again, with no outcome of its own
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 80 }), /is escalated \(archived\)/, 'a later event doesn\'t reopen it');
  record('acme/app#80', 'intake', 'started', {}); // a person ran /software-factory on it again
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 80 }), /already has an active run/, 'reopened: the ordinary rules apply');
  record('acme/app#5', 'intake', 'started', { imported: true });
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 5 }), /imported/);
  process.env.STUB_LOGGED_OUT = '1'; harnessReady.clear();
  try { assert.throws(() => launchSession({ repo: 'acme/app', issue: 3 }), /not signed in: claude auth login/); } finally { delete process.env.STUB_LOGGED_OUT; }
  const s = launchSession({ repo: 'acme/app', issue: 3 }, stubEnv);
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 3 }, stubEnv), /already has a running session/, 'a second POST before the run records anything');
  const ev = await finished(s);
  assert.equal(ev.find((e) => e.data?.type === 'assistant').data.message.content[0].text, 'prompt: /software-factory acme/app#3', 'the prompt is built by the server');
  assert.equal(fs.realpathSync(ev.find((e) => e.data?.subtype === 'init').data.cwd), fs.realpathSync(clone), 'runs in the attached clone');
});

test('POSIX: stop() ends claude\'s own children too (a dev server a Bash tool started)', { skip: process.platform === 'win32' }, async () => {
  const s = startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env: { ...stubEnv, STUB_CHILD: '1' }, label: 'tree' });
  const pid = await new Promise((r) => { const off = subscribe(s, (e) => { if (e.data?.type === 'grandchild') { off(); r(e.data.pid); } }); });
  const end = finished(s); s.stop(); await end;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(), false, `grandchild ${pid} survived`);
});

test('a missing folder is named, not reported as "claude is not installed"', async () => {
  const ev = await finished(startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: path.join(home, 'gone'), env: stubEnv }));
  assert.match(ev.find((e) => e.type === 'error').message, /the folder .*gone does not exist/);
});

test('resumeFor(): only a still-active run whose last event the stopped session wrote; budgetLeft() counts token headroom', () => {
  const last = { state: 'exited', exit: 'SIGTERM', harnessSession: 'abc-1', started: '2026-11-23T10:00:00.000Z', ended: '2026-11-23T10:05:00.000Z' };
  const run = (ts, outcome) => ({ outcome, events: [{ ts }] });
  assert.equal(resumeFor(run('2026-11-23T10:04:00.000Z'), last), 'abc-1');
  assert.equal(resumeFor(run('2026-11-23T10:05:03.000Z'), last), 'abc-1', 'its last lines land just after it ends');
  for (const [r, l, why] of [[run('2026-11-23T10:30:00.000Z'), last, 'someone else wrote it since (a terminal run)'], [run('2026-11-23T09:00:00.000Z'), last, 'it never wrote this run'],
    [run('2026-11-23T10:04:00.000Z', 'merged'), last, 'a finished run starts fresh'], [undefined, last, 'no run: start fresh'], [run('2026-11-23T10:04:00.000Z'), { ...last, exit: 0 }, 'it exited cleanly'],
    [run('2026-11-23T10:04:00.000Z'), { ...last, harnessSession: 'a b' }, 'not a plain id'], [run('2026-11-23T10:04:00.000Z'), { ...last, state: 'running' }, 'still running']]) assert.equal(resumeFor(r, l), undefined, why);
  assert.equal(budgetLeft(null), COST_CAP);
  assert.equal(budgetLeft({ usd: 0, tokens: 0 }), COST_CAP);
  assert.equal(budgetLeft({ usd: 0, tokens: TOKEN_CAP / 2 }), COST_CAP / 2, 'unpriced usage still spends the cap');
  assert.equal(budgetLeft({ usd: COST_CAP * 0.9, tokens: TOKEN_CAP / 2 }), COST_CAP - COST_CAP * 0.9);
});

test('the newest session of a run it may resume is kept (emptied) when finished sessions are pruned', async () => {
  const keep = startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env: { ...stubEnv, STUB_HANG: '1' }, label: 'acme/app#77' });
  await new Promise((r) => { const off = subscribe(keep, (e) => { if (e.data?.subtype === 'init') { off(); r(); } }); });
  const end = finished(keep); keep.stop(); await end;
  for (let i = 0; i < 25; i++) await finished(startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env: stubEnv, label: `filler-${i}` }));
  assert.ok(listSessions().filter((x) => x.label.startsWith('filler-')).length <= 20, 'the rest are pruned');
  assert.deepEqual([getSession(keep.id)?.harnessSession, getSession(keep.id)?.events.length], ['stub-session', 0]);
});

test('launchSession(): a run left active by a stopped session resumes that harness session; a running one is still refused', async () => {
  const s = launchSession({ repo: 'acme/app', issue: 10 }, { ...stubEnv, STUB_HANG: '1' });
  await new Promise((r) => { const off = subscribe(s, (e) => { if (e.data?.subtype === 'init') { off(); r(); } }); });
  record('acme/app#10', 'intake', 'started', {}); // what the session writes as it works
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 10 }, stubEnv), /already has a running session/);
  const end = finished(s); s.stop(); await end;
  const state = () => JSON.parse(uiHandle({ method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:1', 'x-factory-token': 't'.repeat(32) } }, { token: 't'.repeat(32), port: 1 }).body);
  assert.deepEqual(state().resumable, ['acme/app#10'], 'GET /api/state names the runs a start would resume');
  const again = await finished(launchSession({ repo: 'acme/app', issue: 10 }, stubEnv));
  assert.deepEqual(again.find((e) => e.data?.subtype === 'init').data.argv.slice(0, 2), ['--resume', 'stub-session']);
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 10 }, stubEnv), /active run/, 'it exited 0: the run is active for its own reasons');
});

test('/api/sessions: POST starts one behind the token and Origin checks; GET lists; events come back as a stream', async () => {
  const tok = 's'.repeat(32), ctx = { token: tok, port: 4545 }, H = { host: '127.0.0.1:4545', origin: 'http://127.0.0.1:4545', 'content-type': 'application/json', 'x-factory-token': tok };
  const req = (method, url, body, h = {}) => uiHandle({ method, url, headers: { ...H, ...h }, body: body && JSON.stringify(body) }, ctx);
  assert.equal(req('POST', '/api/sessions', { repo: 'acme/app', issue: 6 }, { 'x-factory-token': 'x'.repeat(32) }).status, 403);
  assert.equal(req('POST', '/api/sessions', { repo: 'acme/app', issue: 6 }, { origin: 'https://evil.test' }).status, 403);
  assert.equal(req('POST', '/api/sessions', { repo: 'acme/app', issue: 'x' }).status, 400);
  const ok = req('POST', '/api/sessions', { repo: 'acme/app', issue: 6 });
  assert.equal(ok.status, 200);
  const id = JSON.parse(ok.body).session;
  await finished(getSession(id));
  assert.ok(JSON.parse(req('GET', '/api/sessions').body).sessions.some((x) => x.id === id && x.label === 'acme/app#6' && x.state === 'exited'));
  const st = req('GET', `/api/sessions/${id}/events`, undefined, { 'last-event-id': '1' });
  assert.deepEqual([st.status, st.type, st.stream.id, st.from], [200, 'text/event-stream', id, 2]);
  for (const bad of ['', 'x', '-1', '1e3']) assert.equal(req('GET', `/api/sessions/${id}/events`, undefined, { 'last-event-id': bad }).from, 0, `Last-Event-ID ${JSON.stringify(bad)} replays from 0`);
  assert.match(JSON.parse(req('POST', '/api/sessions/stop', { id }).body).error, /no running session/, 'an exited session');
  assert.equal(req('POST', '/api/sessions/stop', { id }, { 'x-factory-token': 'z'.repeat(32) }).status, 403);
  assert.equal(req('GET', `/api/sessions/${id}/events`, undefined, { 'x-factory-token': 'y'.repeat(32) }).status, 403);
  assert.equal(req('GET', '/api/sessions/00000000-0000-0000-0000-000000000000/events').status, 404);
  assert.match(JSON.parse(req('POST', '/api/sessions/open', { id: 'not-a-desktop-id' }).body).error, /claude --resume/);
});

test('F ui streams a live session over HTTP as server-sent events, to the end', async () => {
  const { server, url } = await serve(0);
  try {
    const u = new URL(url), t = u.searchParams.get('t'), H = { 'x-factory-token': t, origin: u.origin, 'content-type': 'application/json' };
    const { session } = await (await fetch(`${u.origin}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ repo: 'acme/app', issue: 7 }) })).json();
    const signal = AbortSignal.timeout(10_000); // a stream that never ends fails here instead of hanging the run
    const es = await fetch(`${u.origin}/api/sessions/${session}/events`, { headers: { 'x-factory-token': t }, signal }); // live: the run has just started
    assert.equal(es.headers.get('content-type'), 'text/event-stream');
    const blocks = (await es.text()).split('\n\n').filter(Boolean);
    assert.deepEqual(blocks.map((b) => JSON.parse(b.split('data: ')[1]).type).at(-1), 'exit');
    assert.match(blocks[0], /^id: 0\ndata: /);
  } finally { server.closeAllConnections(); server.close(); }
});

test('serve().close(), the desktop app\'s quit: stops the sessions it started (detached, so they would outlive it), then the server', async () => {
  const { url, close } = await serve(0);
  const u = new URL(url), H = { 'x-factory-token': u.searchParams.get('t'), origin: u.origin, 'content-type': 'application/json' };
  process.env.STUB_HANG = '1'; // the stub claude runs until killed
  let id;
  try { ({ session: id } = await (await fetch(`${u.origin}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ repo: 'acme/app', issue: 91 }) })).json()); }
  finally { delete process.env.STUB_HANG; }
  assert.equal(getSession(id).state, 'running');
  const s = getSession(id), stop = s.stop, how = [];
  s.stop = (wait) => { how.push(wait); stop(wait); };
  close();
  assert.deepEqual(how, [true], 'quit waits for the kill (taskkill on Windows)');
  assert.ok((await finished(getSession(id))).length, 'the session ends');
  assert.notEqual(getSession(id).state, 'running');
  assert.equal(await fetch(`${u.origin}/`).then(() => 'up', () => 'down'), 'down');
});

// Stand-ins for node-pty and the Agent SDK: the host passes these in, so no real module or binary is touched.
const PTY = 'node-pty', SDK = '@anthropic-ai/claude-agent-sdk'; // host modules are keyed by package name
function fakePty(spawnError) {
  const rec = {};
  return { rec, spawn(file, args, opts) {
    if (spawnError) throw new Error(spawnError);
    Object.assign(rec, { file, args, cwd: opts.cwd });
    let data, exit;
    setTimeout(() => data('ready\r\n'), 5);
    return { onData: (f) => { data = f; }, onExit: (f) => { exit = f; }, write: (x) => { (rec.writes ||= []).push(x); data(`echo:${x}`); if (x === 'exit\r') exit({ exitCode: 0 }); }, resize: (c, r) => { rec.size = [c, r]; }, kill: () => exit({ exitCode: null }) };
  } };
}
test('terminalSession(): a person\'s own harness in the desktop app\'s pane, in the attached clone or the run\'s worktree', async () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-tclone-')), wt = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-twt-'));
  saveProject('acme/term', clone);
  fs.mkdirSync(path.dirname(wtFile('acme/term#92')), { recursive: true }); fs.writeFileSync(wtFile('acme/term#92'), JSON.stringify({ path: wt }));
  const tok = 't'.repeat(32), H = { host: '127.0.0.1:4646', origin: 'http://127.0.0.1:4646', 'content-type': 'application/json', 'x-factory-token': tok };
  const post = (body) => uiHandle({ method: 'POST', url: '/api/sessions/terminal', headers: H, body: JSON.stringify(body) }, { token: tok, port: 4646 });
  assert.match(JSON.parse(post({ repo: 'acme/term' }).body).error, /needs the desktop app, which supplies node-pty/, 'F ui alone has no pty');
  const pty = fakePty(), modules = { [PTY]: pty };
  for (const [x, re] of [[{ repo: 'acme/nope' }, /not attached/], [{ repo: '../x' }, /owner\/repo/], [{ repo: 'acme/term', issue: 0 }, /positive issue/],
    [{ repo: 'acme/term', resume: '--dangerously-skip-permissions' }, /harness session id/], [{ repo: 'acme/term', resume: '--dangerously-skip-permissions x' }, /harness session id/],
    [{ repo: 'acme/term', resume: 'not-ours-1' }, /a session this app started/], [{ repo: 'acme/term', harness: 'nope' }, /no terminal mode/]])
    assert.throws(() => terminalSession(x, stubEnv, modules), re, JSON.stringify(x));
  const own = terminalSession({ repo: 'acme/term', issue: 92 }, stubEnv, modules);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([own.mode, own.label, pty.rec.file, pty.rec.args, fs.realpathSync(pty.rec.cwd)], ['terminal', 'acme/term#92', 'claude', [], fs.realpathSync(wt)], 'the run\'s worktree');
  let end = finished(own); own.stop(); assert.equal((await end).at(-1).code, 'stopped');

  // The factory's run, stopped in the clone: a terminal resumes it there (claude finds sessions per folder), and once that
  // terminal exits the run is still the factory's to resume.
  const run = launchSession({ repo: 'acme/term', issue: 92 }, { ...stubEnv, STUB_HANG: '1' });
  await new Promise((r) => { const off = subscribe(run, (e) => { if (e.data?.subtype === 'init') { off(); r(); } }); });
  record('acme/term#92', 'intake', 'started', {});
  end = finished(run); run.stop(); await end;
  assert.ok(resumable().includes('acme/term#92'));
  const s = terminalSession({ repo: 'acme/term', issue: 92, resume: 'stub-session' }, stubEnv, modules);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([pty.rec.args, fs.realpathSync(pty.rec.cwd)], [['--resume', 'stub-session'], fs.realpathSync(clone)]);
  assert.throws(() => launchSession({ repo: 'acme/term', issue: 92 }, stubEnv), /already has a running session/, 'not while a person has it open');
  end = finished(s); s.stop(); assert.equal((await end).at(-1).code, 'stopped');
  assert.ok(resumable().includes('acme/term#92'), 'the terminal session doesn\'t replace the run\'s last session');
  const again = await finished(launchSession({ repo: 'acme/term', issue: 92 }, stubEnv));
  assert.deepEqual(again.find((e) => e.data?.subtype === 'init').data.argv.slice(0, 2), ['--resume', 'stub-session']);
});

const fakeSdk = (fail, result = { type: 'result', subtype: 'success' }) => ({ rec: {}, async *query(q) { this.rec.q = q; yield { type: 'system', subtype: 'init', session_id: 'sdk-1' }; if (fail) throw new Error('boom'); if (result) yield result; } });

test('terminal mode: a pseudo-terminal from the host, with input and resize through /api/sessions/input', async () => {
  const pty = fakePty();
  const s = startSession(claude, { mode: 'terminal', resume: 'abc' }, { cwd: home, env: stubEnv, modules: { [PTY]: pty } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([pty.rec.file, pty.rec.args, pty.rec.cwd], ['claude', ['--resume', 'abc'], home]);
  const tok = 't'.repeat(32), H = { host: '127.0.0.1:4646', origin: 'http://127.0.0.1:4646', 'content-type': 'application/json', 'x-factory-token': tok };
  const input = (body) => uiHandle({ method: 'POST', url: '/api/sessions/input', headers: H, body: JSON.stringify(body) }, { token: tok, port: 4646 });
  assert.equal(input({ id: s.id, cols: 100, rows: 30 }).status, 200);
  assert.deepEqual(pty.rec.size, [100, 30]);
  for (const bad of [{ id: s.id, data: 7 }, { id: s.id, data: 'x'.repeat(32769) }, { id: s.id, cols: 0, rows: 5 }, { id: 'nope', data: 'x' }]) assert.equal(input(bad).status, 400, JSON.stringify(bad));
  const writes = []; const w = s.write; s.write = (x) => writes.push(x);
  assert.equal(input({ id: s.id, data: 'ls\r', cols: 0, rows: 5 }).status, 400);
  assert.deepEqual([writes, pty.rec.size], [[], [100, 30]], 'a bad size applies none of the request');
  s.write = w;
  const done = finished(s);
  assert.equal(input({ id: s.id, data: 'exit\r' }).status, 200);
  const ev = await done;
  assert.deepEqual(ev.filter((e) => e.type === 'output').map((e) => e.data), ['ready\r\n', 'echo:exit\r']);
  assert.deepEqual(ev.at(-1).code, 0);
  assert.equal(input({ id: s.id, data: 'x' }).status, 400, 'an exited session takes no input');
});

test('sdk mode: query() from the host, one event per message; a failure or a missing module ends with an error event', async () => {
  const sdk = fakeSdk();
  const ev = await finished(startSession(claude, { mode: 'sdk', prompt: 'hi', budget: 3 }, { cwd: home, modules: { [SDK]: sdk } }));
  assert.deepEqual(ev.map((e) => e.data?.type ?? e.type), ['system', 'result', 'exit']);
  assert.deepEqual([sdk.rec.q.prompt, sdk.rec.q.options.cwd, sdk.rec.q.options.maxBudgetUsd, sdk.rec.q.options.abortController instanceof AbortController], ['hi', home, 3, true]);
  const bad = await finished(startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { [SDK]: fakeSdk(true) } }));
  assert.deepEqual(bad.slice(-2).map((e) => [e.type, e.message ?? e.code]), [['error', 'boom'], ['exit', null]]);
  const nomod = { id: 'x', modes: ['sdk'], launch: () => ({ module: '@nope/none', prompt: 'p', options: {} }) };
  assert.match((await finished(startSession(nomod, { mode: 'sdk' }, { cwd: home }))).find((e) => e.type === 'error').message, /sdk mode needs @nope\/none, which is not installed/);
});

test('terminal on Windows: npm\'s claude.cmd goes to node-pty as one cmd.exe line, not quoted twice', async () => {
  const pty = fakePty(), win = { platform: 'win32', env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, isFile: (p) => p.toLowerCase() === 'c:\\npm\\claude.cmd' };
  const s = startSession(claude, { mode: 'terminal', resume: 'abc' }, { cwd: home, env: stubEnv, modules: { [PTY]: pty }, resolve: win });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([pty.rec.file, pty.rec.args], ['C:\\Windows\\system32\\cmd.exe', '/d /s /c ""C:\\npm\\claude.cmd" --resume abc"']);
  s.stop(); await finished(s);
});

test('a stop while node-pty or the SDK loads is kept: nothing starts', async () => {
  const pty = fakePty(), sdk = fakeSdk();
  const t = startSession(claude, { mode: 'terminal' }, { cwd: home, modules: { [PTY]: pty } }); t.stop();
  const q = startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { [SDK]: sdk } }); q.stop();
  assert.deepEqual([(await finished(t)).at(-1).code, (await finished(q)).at(-1).code], ['stopped', 'stopped']);
  assert.deepEqual([pty.rec.file, sdk.rec.q], [undefined, undefined]);
});

test('sdk mode: the host env reaches the SDK, and a failed result exits 1', async () => {
  const sdk = fakeSdk(), env = { ...stubEnv, FACTORY_MARK: 'x' };
  await finished(startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, env, modules: { [SDK]: sdk } }));
  assert.equal(sdk.rec.q.options.env, env);
  for (const [result, code] of [[{ type: 'result', subtype: 'success' }, 0], [{ type: 'result', subtype: 'error_max_budget_usd' }, 1], [{ type: 'result', subtype: 'success', is_error: true }, 1], [null, 1]]) {
    assert.equal((await finished(startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { [SDK]: fakeSdk(false, result) } }))).at(-1).code, code, JSON.stringify(result));
  }
});

test('a stop mid-run ends as stopped, in a terminal and in the SDK; a missing binary in a pty is "not installed"', async () => {
  const pty = fakePty(), t = startSession(claude, { mode: 'terminal' }, { cwd: home, modules: { [PTY]: pty } });
  await new Promise((r) => setTimeout(r, 20));
  const tEnd = finished(t); t.stop();
  assert.equal((await tEnd).at(-1).code, 'stopped');
  t.write('late'); t.resize(1, 1);
  assert.deepEqual([pty.rec.writes, pty.rec.size], [undefined, undefined], 'a stopped pty takes no input');
  const waiting = { async *query(q) { yield { type: 'system', subtype: 'init' }; await new Promise((_, no) => q.options.abortController.signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' })))); } };
  const q = startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { [SDK]: waiting } });
  await new Promise((r) => { const off = subscribe(q, (e) => { if (e.data?.subtype === 'init') { off(); r(); } }); });
  const qEnd = finished(q); q.stop();
  assert.deepEqual((await qEnd).slice(-1).map((e) => [e.type, e.code]), [['exit', 'stopped']], 'no error event for our own abort');
  const nowhere = { PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'factory-nopath-')) };
  const gone = await finished(startSession(claude, { mode: 'terminal' }, { cwd: home, env: nowhere, modules: { [PTY]: fakePty('posix_spawnp failed.') } }));
  assert.deepEqual(gone.slice(-2).map((e) => e.message ?? e.code), ['claude is not installed', null]);
  if (process.platform !== 'win32') { // the stub is a shell script, found on stubEnv's PATH
    const other = await finished(startSession(claude, { mode: 'terminal' }, { cwd: home, env: stubEnv, modules: { [PTY]: fakePty('posix_spawnp failed.') } }));
    assert.equal(other.find((e) => e.type === 'error').message, 'posix_spawnp failed.', 'claude is there: the pty error passes through');
  }
});

test('launchSession() never starts a terminal session for a factory run: it would have no budget cap', () => {
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 9, mode: 'terminal' }, stubEnv, { [PTY]: fakePty() }), /no budget cap/);
});

test('launchSession() refuses sdk mode up front while no host supplies the SDK (outside the desktop app)', () => {
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 9, mode: 'sdk' }, stubEnv), /needs the desktop app, which supplies @anthropic-ai\/claude-agent-sdk/);
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 9, mode: 'sdk' }, stubEnv, { 'node-pty': fakePty() }), /needs the desktop app/, 'node-pty alone is not the SDK');
});

test('launchSession() passes the host modules on: an sdk run in the attached clone with the run budget and write mode', async () => {
  const sdk = fakeSdk();
  await finished(launchSession({ repo: 'acme/app', issue: 8, mode: 'sdk' }, stubEnv, { [SDK]: sdk }));
  const { prompt, options } = sdk.rec.q;
  assert.deepEqual([prompt, options.cwd, options.maxBudgetUsd, options.permissionMode], ['/software-factory acme/app#8', projects()['acme/app'].path, COST_CAP, 'auto']);
});
