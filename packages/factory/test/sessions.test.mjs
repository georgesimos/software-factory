// H1: the harness launch contract, the session runner and /api/sessions, against test/bin's claude stub only.
// test/bin goes first on PATH and nothing else that could hold a real `claude`: a real one would start a paid run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import { record } from '../../core/src/log.ts';
import { projects, saveProject } from '../../core/src/workspace.ts';
import { command, opener } from '../../core/src/platform.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { startSession, subscribe, getSession } from '../../adapters/sessions.mjs';
import { launchSession, ui, uiHandle } from '../../server/src/server.ts';
import { COST_CAP } from '../../core/src/constants.ts';

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
  assert.throws(() => claude.launch({ mode: 'headless' }), /needs a prompt/);
  const sd = claude.launch({ mode: 'sdk', prompt: 'x', budget: 2 });
  assert.deepEqual([sd.module, sd.prompt, sd.options.permissionMode, sd.options.maxBudgetUsd, sd.options.strictMcpConfig], ['@anthropic-ai/claude-agent-sdk', 'x', 'dontAsk', 2, true]);
  assert.deepEqual([claude.launch({ mode: 'sdk', prompt: 'x', write: true }).options.permissionMode, claude.launch({ mode: 'sdk', prompt: 'x', write: true }).options.allowedTools], ['auto', undefined]);
  assert.equal(sd.options.permissionPrompts, 'none', 'no prompt can stall an sdk run');
  assert.throws(() => claude.launch({ mode: 'sdk' }), /needs a prompt/);
  assert.throws(() => claude.launch({ mode: 'nope', prompt: 'x' }), /no nope mode/);
  assert.ok(claude.headlessArgs().includes('json') && !claude.headlessArgs().includes('stream-json'), 'F headless-args is unchanged');
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
  record('acme/app#5', 'intake', 'started', { imported: true });
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 5 }), /imported/);
  process.env.STUB_LOGGED_OUT = '1';
  try { assert.throws(() => launchSession({ repo: 'acme/app', issue: 3 }), /not signed in: claude auth login/); } finally { delete process.env.STUB_LOGGED_OUT; }
  const s = launchSession({ repo: 'acme/app', issue: 3 }, stubEnv);
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 3 }, stubEnv), /already has a running session/, 'a second POST before the run records anything');
  const ev = await finished(s);
  assert.equal(ev.find((e) => e.data?.type === 'assistant').data.message.content[0].text, 'prompt: /software-factory acme/app#3', 'the prompt is built by the server');
  assert.equal(fs.realpathSync(ev.find((e) => e.data?.subtype === 'init').data.cwd), fs.realpathSync(clone), 'runs in the attached clone');
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
  const log = console.log; let url;
  console.log = (x) => { url = /http:\S+/.exec(String(x))?.[0] ?? url; };
  const server = ui(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const u = new URL(url), t = u.searchParams.get('t'), H = { 'x-factory-token': t, origin: u.origin, 'content-type': 'application/json' };
    const { session } = await (await fetch(`${u.origin}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ repo: 'acme/app', issue: 7 }) })).json();
    const signal = AbortSignal.timeout(10_000); // a stream that never ends fails here instead of hanging the run
    const es = await fetch(`${u.origin}/api/sessions/${session}/events`, { headers: { 'x-factory-token': t }, signal }); // live: the run has just started
    assert.equal(es.headers.get('content-type'), 'text/event-stream');
    const blocks = (await es.text()).split('\n\n').filter(Boolean);
    assert.deepEqual(blocks.map((b) => JSON.parse(b.split('data: ')[1]).type).at(-1), 'exit');
    assert.match(blocks[0], /^id: 0\ndata: /);
  } finally { console.log = log; server.closeAllConnections(); server.close(); }
});

// Stand-ins for node-pty and the Agent SDK: the host passes these in, so no real module or binary is touched.
function fakePty() {
  const rec = {};
  return { rec, spawn(file, args, opts) {
    Object.assign(rec, { file, args, cwd: opts.cwd });
    let data, exit;
    setTimeout(() => data('ready\r\n'), 5);
    return { onData: (f) => { data = f; }, onExit: (f) => { exit = f; }, write: (x) => { data(`echo:${x}`); if (x === 'exit\r') exit({ exitCode: 0 }); }, resize: (c, r) => { rec.size = [c, r]; }, kill: () => exit({ exitCode: null }) };
  } };
}
const fakeSdk = (fail, result = { type: 'result', subtype: 'success' }) => ({ rec: {}, async *query(q) { this.rec.q = q; yield { type: 'system', subtype: 'init', session_id: 'sdk-1' }; if (fail) throw new Error('boom'); if (result) yield result; } });

test('terminal mode: a pseudo-terminal from the host, with input and resize through /api/sessions/input', async () => {
  const pty = fakePty();
  const s = startSession(claude, { mode: 'terminal', resume: 'abc' }, { cwd: home, env: stubEnv, modules: { pty } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([pty.rec.file, pty.rec.args, pty.rec.cwd], ['claude', ['--resume', 'abc'], home]);
  const tok = 't'.repeat(32), H = { host: '127.0.0.1:4646', origin: 'http://127.0.0.1:4646', 'content-type': 'application/json', 'x-factory-token': tok };
  const input = (body) => uiHandle({ method: 'POST', url: '/api/sessions/input', headers: H, body: JSON.stringify(body) }, { token: tok, port: 4646 });
  assert.equal(input({ id: s.id, cols: 100, rows: 30 }).status, 200);
  assert.deepEqual(pty.rec.size, [100, 30]);
  for (const bad of [{ id: s.id, data: 7 }, { id: s.id, cols: 0, rows: 5 }, { id: 'nope', data: 'x' }]) assert.equal(input(bad).status, 400, JSON.stringify(bad));
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
  const ev = await finished(startSession(claude, { mode: 'sdk', prompt: 'hi', budget: 3 }, { cwd: home, modules: { sdk } }));
  assert.deepEqual(ev.map((e) => e.data?.type ?? e.type), ['system', 'result', 'exit']);
  assert.deepEqual([sdk.rec.q.prompt, sdk.rec.q.options.cwd, sdk.rec.q.options.maxBudgetUsd, sdk.rec.q.options.abortController instanceof AbortController], ['hi', home, 3, true]);
  const bad = await finished(startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { sdk: fakeSdk(true) } }));
  assert.deepEqual(bad.slice(-2).map((e) => [e.type, e.message ?? e.code]), [['error', 'boom'], ['exit', null]]);
  const nomod = { id: 'x', modes: ['sdk'], launch: () => ({ module: '@nope/none', prompt: 'p', options: {} }) };
  assert.match((await finished(startSession(nomod, { mode: 'sdk' }, { cwd: home }))).find((e) => e.type === 'error').message, /sdk mode needs @nope\/none, which is not installed/);
});

test('terminal on Windows: npm\'s claude.cmd goes to node-pty as one cmd.exe line, not quoted twice', async () => {
  const pty = fakePty(), win = { platform: 'win32', env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, isFile: (p) => p.toLowerCase() === 'c:\\npm\\claude.cmd' };
  const s = startSession(claude, { mode: 'terminal', resume: 'abc' }, { cwd: home, env: stubEnv, modules: { pty }, resolve: win });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([pty.rec.file, pty.rec.args], ['C:\\Windows\\system32\\cmd.exe', '/d /s /c ""C:\\npm\\claude.cmd" --resume abc"']);
  s.stop(); await finished(s);
});

test('a stop while node-pty or the SDK loads is kept: nothing starts', async () => {
  const pty = fakePty(), sdk = fakeSdk();
  const t = startSession(claude, { mode: 'terminal' }, { cwd: home, modules: { pty } }); t.stop();
  const q = startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { sdk } }); q.stop();
  assert.deepEqual([(await finished(t)).at(-1).code, (await finished(q)).at(-1).code], ['stopped', 'stopped']);
  assert.deepEqual([pty.rec.file, sdk.rec.q], [undefined, undefined]);
});

test('sdk mode: the host env reaches the SDK, and a failed result exits 1', async () => {
  const sdk = fakeSdk(), env = { ...stubEnv, FACTORY_MARK: 'x' };
  await finished(startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, env, modules: { sdk } }));
  assert.equal(sdk.rec.q.options.env, env);
  for (const [result, code] of [[{ type: 'result', subtype: 'success' }, 0], [{ type: 'result', subtype: 'error_max_budget_usd' }, 1], [{ type: 'result', subtype: 'success', is_error: true }, 1], [null, 1]]) {
    assert.equal((await finished(startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { sdk: fakeSdk(false, result) } }))).at(-1).code, code, JSON.stringify(result));
  }
});

test('launchSession() never starts a terminal session for a factory run: it would have no budget cap', () => {
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 9, mode: 'terminal' }, stubEnv, { pty: fakePty() }), /no budget cap/);
});

test('launchSession() passes the host modules on: an sdk run in the attached clone with the run budget and write mode', async () => {
  const sdk = fakeSdk();
  await finished(launchSession({ repo: 'acme/app', issue: 8, mode: 'sdk' }, stubEnv, { sdk }));
  const { prompt, options } = sdk.rec.q;
  assert.deepEqual([prompt, options.cwd, options.maxBudgetUsd, options.permissionMode], ['/software-factory acme/app#8', projects()['acme/app'].path, COST_CAP, 'auto']);
});
