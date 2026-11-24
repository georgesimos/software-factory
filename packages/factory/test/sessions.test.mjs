// H1: the harness launch contract, the session runner and /api/sessions, against test/bin's claude stub only.
// test/bin goes first on PATH and nothing else that could hold a real `claude`: a real one would start a paid run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { COST_CAP, TOKEN_CAP } from '../../core/src/constants.ts';
import { HERE } from '../factory.mjs';
import { archive, io, read, record, runDir } from '../../core/src/log.ts';
import { derive } from '../../core/src/derive.ts';
import { projects, saveProject, wtFile } from '../../core/src/workspace.ts';
import { command, opener } from '../../core/src/platform.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { MAX_BYTES, killTree, listSessions, resolveSpec, startSession, subscribe, getSession } from '../../adapters/sessions.mjs';
import { budgetLeft, harnessReady, launchSession, openSession, resumable, resumeFor, serve, startRun, terminalSession, uiHandle } from '../../server/src/server.ts';
import { procStart, readClaim, statTicks, takeClaim, unclaim } from '../../server/src/claim.ts';

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

test('record() stamps the desktop session id from CLAUDE_CODE_HOST_SESSION_ID only, valid ones only; derive keeps it on the session', () => {
  const env = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const forged = { hostSessionId: 'local_ffffffff-ffff-4fff-8fff-ffffffffffff' };
  try {
    env('CLAUDE_CODE_SESSION_ID', 'cli-1'); env('CLAUDE_CODE_HOST_SESSION_ID', LOCAL);
    assert.equal(record('acme/host#1', 'intake', 'started', forged).hostSessionId, LOCAL, 'the env wins; the payload\'s is dropped');
    env('CLAUDE_CODE_HOST_SESSION_ID', `${LOCAL}; open -a Calculator`);
    assert.equal(record('acme/host#2', 'intake', 'started').hostSessionId, undefined, 'not a local_<uuid>: not recorded');
    env('CLAUDE_CODE_HOST_SESSION_ID', undefined);
    assert.equal(record('acme/host#3', 'intake', 'started', forged).hostSessionId, undefined, 'a payload alone never sets it');
    env('CLAUDE_CODE_SESSION_ID', undefined); env('CLAUDE_CODE_HOST_SESSION_ID', LOCAL);
    assert.equal(record('acme/host#4', 'intake', 'started', forged).hostSessionId, undefined, 'not inside claude-code: an inherited id isn\'t this run\'s');
  } finally { env('CLAUDE_CODE_SESSION_ID', undefined); env('CLAUDE_CODE_HOST_SESSION_ID', undefined); }
  assert.deepEqual(derive(read())['acme/host#1'].sessions.map((x) => [x.id, x.hostId]), [['cli-1', LOCAL]]);
  assert.deepEqual(derive(read())['acme/host#2'].sessions.map((x) => [x.id, x.hostId]), [['cli-1', undefined]]);
});

test('openSession() (F open <id>, POST /api/sessions/open): the desktop app when there is a desktop id, else how to resume it where it ran', () => {
  const opened = [], launch = (url) => { opened.push(url); return url; }; // the OS opener, stubbed
  for (const bad of [undefined, 7, '--resume', 'a b', '../x', 'x'.repeat(101)]) assert.throws(() => openSession({ id: bad }, launch), /id must be a session id/, String(bad));
  assert.throws(() => openSession({ harness: 'nope', id: 'cli-1' }, launch), /no harness/);
  assert.deepEqual(openSession({ id: LOCAL }, launch), { opened: `claude://claude.ai/epitaxy/${LOCAL}` }, 'its own desktop id');
  const later = LOCAL.replace('0123abcd', 'fedcba98'), at = (id, host, run) => { process.env.CLAUDE_CODE_SESSION_ID = id; process.env.CLAUDE_CODE_HOST_SESSION_ID = host; try { record(run, 'intake', 'started'); } finally { delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CLAUDE_CODE_HOST_SESSION_ID; } };
  at('cli-7', later, 'acme/open#2'); at('cli-7', LOCAL, 'acme/open#1'); // one CLI session, two runs: the newer write is #1's
  assert.deepEqual(openSession({ id: 'cli-7' }, launch), { opened: `claude://claude.ai/epitaxy/${LOCAL}` }, 'the desktop id last recorded with the CLI session\'s events');
  record('acme/host#5', 'intake', 'started', { harness: 'claude-code', sessionId: 'term-9', cwd: '/work/acme' }); // a plain terminal: no desktop id
  assert.deepEqual(openSession({ id: 'term-9' }, launch), { resume: { command: 'claude --resume term-9', cwd: '/work/acme' } });
  assert.deepEqual(openSession({ id: 'never-seen' }, launch), { resume: { command: 'claude --resume never-seen' } });
  assert.deepEqual(opened, [`claude://claude.ai/epitaxy/${LOCAL}`, `claude://claude.ai/epitaxy/${LOCAL}`], 'the opener only ever gets the claude:// link');
  const cl = takeClaim('acme/host#5', 'start'); // F start on that run: a resume would put a second harness on it
  assert.throws(() => openSession({ id: 'term-9' }, launch), /acme\/host#5 already has a running session \(start, not started yet\)/);
  cl.release();
  fs.writeFileSync(path.join(runDir('acme/host#5'), 'claim.json'), '{'); // unreadable: live, as takeClaim treats it
  assert.throws(() => openSession({ id: 'term-9' }, launch), /\(unreadable claim\)\. If nothing is starting it.*F unclaim acme\/host#5 --force/);
  fs.rmSync(path.join(runDir('acme/host#5'), 'claim.json'));
  const c7 = takeClaim('acme/open#1', 'session'); // opening the desktop chat that drove it adds no harness
  assert.deepEqual([openSession({ id: LOCAL }, launch), openSession({ id: 'cli-7' }, launch)], [{ opened: `claude://claude.ai/epitaxy/${LOCAL}` }, { opened: `claude://claude.ai/epitaxy/${LOCAL}` }]);
  c7.release();
  assert.equal(opened.length, 4, 'opened only the desktop links, never while a resume was refused');
});

test('a spawned harness never inherits the ids of the session F runs in: headless, terminal and sdk', async () => {
  const env = { ...stubEnv, CLAUDE_CODE_SESSION_ID: 'outer-1', CLAUDE_CODE_HOST_SESSION_ID: LOCAL };
  const ev = await finished(startSession(claude, { mode: 'headless', prompt: 'x' }, { cwd: home, env }));
  assert.deepEqual(ev.find((e) => e.data?.subtype === 'init').data.parentIds, []);
  const pty = fakePty(), sdk = fakeSdk();
  const t = startSession(claude, { mode: 'terminal' }, { cwd: home, env, modules: { [PTY]: pty } });
  await new Promise((r) => setTimeout(r, 20)); const end = finished(t); t.stop(); await end;
  await finished(startSession(claude, { mode: 'sdk', prompt: 'x' }, { cwd: home, env, modules: { [SDK]: sdk } }));
  for (const e of [pty.rec.env, sdk.rec.q.options.env]) assert.deepEqual([e.CLAUDE_CODE_SESSION_ID, e.CLAUDE_CODE_HOST_SESSION_ID, e.PATH], [undefined, undefined, stubEnv.PATH]);
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
  const root = process.env.SystemRoot; // pinned: real Windows has its own (often C:\\WINDOWS)
  const pin = (v) => { if (v === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = v; };
  try {
    pin('C:\\Windows');
    const calls = [], run = (...a) => { calls.push(a.slice(0, 2)); return { on: () => {} }; }, groups = [], kill = (pid, sig) => { groups.push([pid, sig]); };
    let killed = 0; const child = { pid: 4242, kill: () => { killed++; } };
    killTree(child, 'win32', run, kill);
    const TK = 'C:\\Windows\\System32\\taskkill.exe'; // by full path, never a taskkill.exe in the worktree (#97)
    assert.deepEqual([calls, killed], [[[TK, ['/pid', '4242', '/T', '/F']]], 0]);
    killTree(child, 'darwin', run, kill);
    assert.deepEqual(groups, [[-4242, 'SIGTERM']], 'POSIX: the whole process group');
    killTree(child, 'linux', run, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    killTree({ pid: 0, kill: () => { killed += 10; } }, 'darwin', run, kill); killTree({ pid: 0 }, 'win32', run, kill);
    assert.deepEqual([calls.length, groups.length, killed], [1, 1, 1], 'never pid 0; the child alone when its group is gone');
    const waited = []; // quit: spawnSync's shape (no .on), bounded so quit can't hang
    killTree(child, 'win32', (...a) => { waited.push(a); return { status: 0 }; }, kill, true);
    assert.deepEqual(waited, [[TK, ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }]]);
    pin('D:\\WINNT');
    killTree(child, 'win32', run, kill);
    assert.equal(calls.at(-1)[0], 'D:\\WINNT\\System32\\taskkill.exe', 'under %SystemRoot%');
  } finally { pin(root); }
});

test('the command is found on the PATH and PATHEXT the session gets, not this process\'s', () => {
  const env = { PATH: 'D:\\tools', PATHEXT: '.EXE' }, resolve = { platform: 'win32', isFile: (p) => p.toLowerCase() === 'd:\\tools\\claude.exe' };
  assert.equal(resolveSpec({ cmd: 'claude', args: ['-p'] }, env, resolve).file, 'D:\\tools\\claude.exe');
  assert.throws(() => resolveSpec({ cmd: 'claude', args: ['-p'] }, { PATH: 'C:\\other' }, resolve), { code: 'ENOENT', message: 'claude is not installed' }); // never the bare name, which Windows looks up in the current folder first
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

test('startRun() (F start, POST /api/runs): launchSession\'s checks, then a detached headless run that logs to the run\'s folder', async () => {
  for (const [x, re] of [[undefined, /owner\/repo#N/], ['acme/app 7', /owner\/repo#N/], ['acme/app#7; rm -rf ~', /owner\/repo#N/], ['acme/nope#7', /not attached/], ['acme/app#0', /positive issue number/]])
    assert.throws(() => startRun(x, stubEnv, () => assert.fail('no spawn')), re, String(x));
  record('acme/app#40', 'approve', 'escalated', {});
  assert.throws(() => startRun('acme/app#40', stubEnv, () => assert.fail('no spawn')), /escalated: it needs a human/);
  const calls = [], fake = (file, args, opts) => { calls.push({ file, args, opts }); return { pid: process.pid, on() { return this; }, unref() {} }; }; // a live pid
  const r = startRun('acme/app#41', { ...stubEnv, CLAUDE_CODE_SESSION_ID: 'outer-1', CLAUDE_CODE_HOST_SESSION_ID: LOCAL }, fake);
  const [{ file, args, opts }] = calls;
  assert.equal(path.basename(file), 'claude');
  assert.deepEqual([args[0], args.includes('stream-json'), opts.detached, opts.windowsHide, fs.realpathSync(opts.cwd)], ['-p', true, true, true, fs.realpathSync(projects()['acme/app'].path)]);
  assert.ok(opts.stdio.every((fd) => typeof fd === 'number'), 'files, not pipes: nothing waits on F');
  assert.deepEqual([opts.env.CLAUDE_CODE_SESSION_ID, opts.env.CLAUDE_CODE_HOST_SESSION_ID], [undefined, undefined], 'childEnv: never the ids of the session F runs in');
  assert.deepEqual([r.pid, path.dirname(r.log), fs.readFileSync(r.log.replace(/\.log$/, '.prompt'), 'utf8')], [process.pid, runDir('acme/app#41'), '/software-factory acme/app#41']);
  assert.throws(() => startRun('acme/app#41', stubEnv, fake), /already has a running session \(start, pid \d+\)/, 'not twice before its first event');
  assert.throws(() => launchSession({ repo: 'acme/app', issue: 41 }, stubEnv), /already has a running session/);
  const tok = 't'.repeat(32), H = { host: '127.0.0.1:4646', origin: 'http://127.0.0.1:4646', 'content-type': 'application/json', 'x-factory-token': tok };
  const post = (body, h = H) => uiHandle({ method: 'POST', url: '/api/runs', headers: h, body: JSON.stringify(body) }, { token: tok, port: 4646 });
  assert.equal(post({ issue: 'acme/app#41' }, { ...H, 'x-factory-token': 'x'.repeat(32) }).status, 403);
  assert.equal(post({ issue: 'acme/app#41' }, { ...H, origin: 'http://evil.example' }).status, 403);
  assert.match(JSON.parse(post({ issue: 'acme/app#41' }).body).error, /already has a running session/);

  // For real: F start returns, and the detached stub claude it left behind reads its prompt and writes the log.
  const f = spawnSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'start', 'acme/app#42'], { env: { ...stubEnv, FACTORY_DIR: io.dir }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(f.status, 0, f.stderr);
  const { pid, log } = JSON.parse(f.stdout);
  assert.ok(pid > 0);
  for (let i = 0; i < 100 && !/prompt: \/software-factory acme\/app#42/.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''); i++) await new Promise((res) => setTimeout(res, 100));
  assert.match(fs.readFileSync(log, 'utf8'), /prompt: \/software-factory acme\/app#42/);
});

// An lstart string ms later than another, as ps prints it (UTC).
const lstartPlus = (x, ms) => { const d = new Date(Date.parse(x.replace(/^\w{3} +(\w{3}) +(\d+) (\S+) (\d{4})$/, '$2 $1 $4 $3 UTC')) + ms);
  return `${'SunMonTueWedThuFriSat'.slice(d.getUTCDay() * 3, d.getUTCDay() * 3 + 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`; };
test('statTicks(): the start time from /proc/<pid>/stat, past a command name with spaces and parentheses', () => {
  const rest = Array.from({ length: 18 }, (_, i) => String(i + 1)).join(' ');
  assert.equal(statTicks(`42 (a) b) c) S ${rest} 777 99 1`), 'ticks:777');
  assert.equal(statTicks('42 (x)'), undefined);
  if (process.platform === 'linux') assert.match(procStart(process.pid), /^ticks:\d+$/);
});
const claimAt = (id, c) => { fs.mkdirSync(runDir(id), { recursive: true }); fs.writeFileSync(path.join(runDir(id), 'claim.json'), JSON.stringify({ at: new Date().toISOString(), ...c })); };
test('takeClaim(): one launcher per run across processes; a dead, reused or foreign pid doesn\'t hold it', { skip: process.platform === 'win32' && 'start times are POSIX (ps)' }, () => {
  const id = 'acme/claims#1', file = path.join(runDir(id), 'claim.json');
  const a = takeClaim(id, 'start');
  assert.throws(() => takeClaim(id, 'session'), /acme\/claims#1 already has a running session \(start, not started yet\)\. If nothing is starting it \(check for a running claude on acme\/claims#1 first\): F unclaim acme\/claims#1 --force/, 'pid 0: between its claim and its spawn');
  a.update({ pid: process.pid, since: procStart(process.pid) });
  assert.throws(() => takeClaim(id, 'session'), /\(start, pid \d+\)/);
  a.release();
  assert.equal(fs.existsSync(file), false);
  for (const [c, why] of [[{ pid: process.pid, since: 'Mon Jan  1 00:00:00 2001', launcher: 'start' }, 'a reused pid: its start time differs'],
    [{ pid: process.pid, since: procStart(process.pid)?.startsWith('ticks:') ? 'ticks:1' : lstartPlus(procStart(process.pid), 60_000), launcher: 'start' }, 'another start time'],
    [{ pid: 999_999_9, since: 'x', launcher: 'start' }, 'no such pid']]) {
    claimAt(id, c);
    const b = takeClaim(id, 'session', { pid: process.pid });
    assert.equal(readClaim(id).token, b.claim.token, why);
    b.release();
  }
  const me = procStart(process.pid);
  const linux = me?.startsWith('ticks:'); // Linux: start ticks, compared exactly; elsewhere lstart, within 5 s
  for (const [c, why] of [...(linux ? [] : [[{ pid: process.pid, since: lstartPlus(me, 1_000), launcher: 'start' }, 'a second off: lstart drifts after an NTP step']]),
    [{ pid: process.pid, launcher: 'start' }, 'no start time: unsure means live'], [{ pid: process.pid, since: 'garbled', launcher: 'start' }, 'an unreadable start time'],
    ...(process.getuid?.() === 0 ? [] : [[{ pid: 1, since: 'garbled', launcher: 'start' }, 'EPERM: the pid exists']])]) {
    claimAt(id, c);
    assert.throws(() => takeClaim(id, 'session'), /already has a running session \(start, pid \d+\)\. If that process is gone: F unclaim acme\/claims#1 \(it deletes .*claim\.json\)/, why);
  }
  assert.throws(() => unclaim(id), /claim is live \(pid \d+\): stop that process first, or \(check for a running claude on acme\/claims#1 first\) F unclaim acme\/claims#1 --force/);
  const held = readClaim(id);
  assert.deepEqual(unclaim(id, true), { unclaimed: true, pid: held.pid, launcher: 'start' }, '--force: the user knows it is gone');
  assert.equal(readClaim(id), undefined);
  assert.deepEqual(unclaim(id), { unclaimed: false, why: 'no claim' });
  claimAt(id, { pid: 999_999_9, launcher: 'start' });
  assert.deepEqual(unclaim(id), { unclaimed: true, pid: 999_999_9, launcher: 'start' }, 'its pid is gone: no --force needed');
  const f = (...a) => spawnSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'unclaim', ...a], { env: { ...stubEnv, FACTORY_DIR: io.dir }, encoding: 'utf8' });
  claimAt(id, { pid: process.pid, since: me, launcher: 'session' });
  assert.match(f(id).stderr, /claim is live/);
  assert.equal(JSON.parse(f(id, '--force').stdout).unclaimed, true);
  for (const [bad, re] of [[[], /usage: unclaim/], [[id, '--yes'], /usage: unclaim/], [['acme/claims'], /owner\/repo#N/], [['../x#1'], /owner\/repo/]]) assert.match(f(...bad).stderr, re, bad.join(' '));
  const dot = 'o/.github#3'; // any run id F start takes: the same parser
  claimAt(dot, { pid: 999_999_9, launcher: 'start' });
  assert.equal(JSON.parse(f(dot).stdout).unclaimed, true);
  claimAt(dot, { pid: 0, launcher: 'start' });
  assert.match(f(dot).stderr, /not started yet.*F unclaim o\/\.github#3 --force/);
  assert.equal(JSON.parse(f(dot, '--force').stdout).unclaimed, true);
  // Never stale by age: an hour-old claim with no pid yet, an unreadable one and an empty one hold until F unclaim --force.
  for (const [body, re] of [[JSON.stringify({ pid: 0, launcher: 'start', at: new Date(Date.now() - 3_600_000).toISOString() }), /not started yet\)\. If nothing is starting it \(check for a running claude on acme\/claims#1 first\): F unclaim acme\/claims#1 --force/],
    ['{', /\(unreadable claim\)\. If nothing is starting it \(check for a running claude on acme\/claims#1 first\): F unclaim acme\/claims#1 --force/], ['', /unreadable claim/]]) {
    fs.writeFileSync(file, body);
    fs.utimesSync(file, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    assert.throws(() => takeClaim(id, 'session'), re, JSON.stringify(body));
    assert.throws(() => unclaim(id), /F unclaim acme\/claims#1 --force/);
    assert.equal(unclaim(id, true).unclaimed, true);
  }
  const w = takeClaim(id, 'start'); w.update({ log: 'x' });
  assert.deepEqual([readClaim(id).log, fs.readdirSync(runDir(id)).filter((x) => x.endsWith('.tmp'))], ['x', []], 'written aside and renamed in: never half a file');
  w.release();
  const c = takeClaim(id, 'start'); claimAt(id, { pid: 0, launcher: 'other', token: 'x' });
  c.release();
  assert.equal(readClaim(id).launcher, 'other', 'release() never drops a claim another launcher took over');
  unclaim(id, true);
  // A, not started yet, is cleared with --force; B takes the run and starts. A's late update() must not overwrite B's claim.
  const A = takeClaim(id, 'start');
  unclaim(id, true);
  const B = takeClaim(id, 'session');
  B.update({ pid: process.pid, since: me });
  assert.throws(() => A.update({ pid: 999_999_9, since: 'x' }), /claim was cleared and taken by session \(F unclaim\) before this harness started/);
  A.release();
  assert.deepEqual([readClaim(id).token, readClaim(id).pid], [B.claim.token, process.pid], "B's claim is intact");
  B.release();
  assert.equal(readClaim(id), undefined);
  assert.throws(() => A.update({ pid: 1 }), /claim was cleared \(F unclaim\)/, 'cleared and not retaken: still not ours');
  assert.equal(fs.existsSync(file), false);
  fs.symlinkSync(path.join(runDir(id), 'gone'), file); // a dangling link: takeClaim refuses and names --force, which clears it
  assert.throws(() => takeClaim(id, 'session'), /unreadable claim.*--force/);
  assert.throws(() => unclaim(id), /unreadable/);
  assert.equal(unclaim(id, true).unclaimed, true);
  assert.throws(() => fs.lstatSync(file), /ENOENT/);
});

test('a claim held in another process refuses launchSession(), startRun() and a terminal, finished run or not; a stale one is dropped; a failed spawn leaves nothing', () => {
  const id = 'acme/app#61', other = { pid: process.pid, since: procStart(process.pid), launcher: 'start' }; // live, and not a session here
  claimAt(id, other);
  const modules = { [PTY]: fakePty() };
  for (const go of [() => launchSession({ repo: 'acme/app', issue: 61 }, stubEnv), () => startRun(id, stubEnv, () => assert.fail('no spawn')), () => terminalSession({ repo: 'acme/app', issue: 61 }, stubEnv, modules)])
    assert.throws(go, /acme\/app#61 already has a running session \(start/);
  assert.equal(listSessions().some((x) => x.label === id), false);
  record(id, 'approve', 'closed', {});
  assert.throws(() => startRun(id, stubEnv, () => assert.fail('no spawn')), /\(start, pid/, 'closed, but its process is still finishing');
  claimAt(id, { pid: process.pid, launcher: 'start' });
  assert.throws(() => startRun(id, stubEnv, () => assert.fail('no spawn')), /\(start, pid/, 'no start time (Windows): live while the pid is, finished run or not');
  claimAt(id, { ...other, since: 'Mon Jan  1 00:00:00 2001' }); // that pid, reused since: stale
  const killed = [], ghost = () => ({ pid: 999_999_9, on() { return this; }, unref() {}, kill() { killed.push(this.pid); } }); // no start time to read
  assert.throws(() => startRun(id, stubEnv, ghost), process.platform === 'win32' ? /x^/ : /could not read the start time of pid 9999999/);
  if (process.platform !== 'win32') assert.deepEqual([killed, readClaim(id)], [[999_999_9], undefined], 'killed, and the claim let go');
  claimAt(id, { ...other, since: 'Mon Jan  1 00:00:00 2001' }); // that pid, reused since
  const dead = (file, args, opts) => { opts.stdio.forEach((fd) => assert.equal(typeof fd, 'number')); return { pid: undefined, on() { return this; }, unref() {} }; };
  assert.throws(() => startRun(id, stubEnv, dead), /claude did not start/, 'past the claim: the closed run\'s claim was dropped');
  assert.equal(readClaim(id), undefined, 'no claim left behind');
  assert.deepEqual(fs.readdirSync(runDir(id)).filter((f) => f.startsWith('headless-')), [], 'no empty log or prompt');
  assert.throws(() => startRun(id, stubEnv, () => { throw new Error('EAGAIN'); }), /EAGAIN/);
  assert.equal(readClaim(id), undefined);
});

test('a session started here claims under its harness\'s pid, so a harness the app leaves behind still holds the run', { skip: process.platform === 'win32' && 'start times are POSIX (ps)' }, async () => {
  const s = launchSession({ repo: 'acme/app', issue: 64 }, { ...stubEnv, STUB_HANG: '1' });
  await new Promise((r) => { const off = subscribe(s, (e) => { if (e.data?.subtype === 'init') { off(); r(); } }); });
  const c = readClaim('acme/app#64');
  assert.ok(c.pid > 0 && c.pid !== process.pid && c.since === procStart(c.pid), JSON.stringify(c));
  let end = finished(s); s.stop(); await end;
  assert.equal(readClaim('acme/app#64'), undefined, 'let go when it exits');
  const t = terminalSession({ repo: 'acme/app', issue: 65 }, stubEnv, { [PTY]: fakePty(undefined, process.ppid) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([readClaim('acme/app#65').launcher, readClaim('acme/app#65').pid], ['terminal', process.ppid], 'the pty\'s pid');
  end = finished(t); t.stop(); await end;
});

test('a start resumes from the newest F start log that wrote the run\'s last event, not just the newest log', () => {
  const id = 'acme/app#66', dir = runDir(id), now = Date.now(), stamp = (t) => new Date(t).toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(dir, { recursive: true });
  const log = (t0, t1, sid) => { const f = path.join(dir, `headless-${stamp(t0)}.log`); fs.writeFileSync(f, sid ? JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\n' : 'no init\n'); fs.utimesSync(f, new Date(t1), new Date(t1)); };
  log(now - 600_000, now + 1_000, 'old-sess'); // ran when the run's last event was written
  log(now + 60_000, now + 120_000, 'new-sess'); // a later resume that died before writing anything
  log(now + 200_000, now + 300_000); // no session id at all
  record(id, 'intake', 'started', {});
  const calls = [];
  startRun(id, stubEnv, (file, args) => { calls.push(args); return { pid: process.pid, on() { return this; }, unref() {} }; });
  assert.deepEqual(calls[0].slice(0, 2), ['--resume', 'old-sess']);
});

const logged = async (log, re) => { for (let i = 0; i < 100 && !re.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''); i++) await new Promise((res) => setTimeout(res, 100)); };
test('F start, killed: the next start resumes its harness session from its log, after a terminal or a failed start too; a clean exit is not resumed', { skip: process.platform === 'win32' && 'the stub runs under a cmd.exe shim there' }, async () => {
  const id = 'acme/app#62', r = startRun(id, { ...stubEnv, STUB_HANG: '1' });
  const alive = () => { try { process.kill(r.pid, 0); return true; } catch { return false; } };
  try {
    await logged(r.log, /"session_id":"stub-session"/);
    assert.equal(readClaim(id).pid, r.pid);
    record(id, 'intake', 'started', {}); // what the run writes as it works
    assert.throws(() => startRun(id, stubEnv, () => assert.fail('no spawn')), /\(start, pid \d+\)/, 'still running');
  } finally { process.kill(-r.pid, 'SIGKILL'); }
  for (let i = 0; i < 100 && alive(); i++) await new Promise((res) => setTimeout(res, 20));
  const t = terminalSession({ repo: 'acme/app', issue: 62 }, stubEnv, { [PTY]: fakePty() }); // a look after the crash takes the claim over
  const end = finished(t); t.stop(); await end;
  assert.throws(() => startRun(id, stubEnv, () => { throw new Error('EAGAIN'); }), /EAGAIN/);
  const calls = [];
  startRun(id, stubEnv, (file, args) => { calls.push(args); return { pid: process.pid, on() { return this; }, unref() {} }; });
  assert.deepEqual(calls[0].slice(0, 2), ['--resume', 'stub-session']);
  assert.equal(readClaim(id).pid, process.pid, 'the new run holds the claim');

  const done = startRun('acme/app#63', stubEnv); // runs to its success result
  await logged(done.log, /"subtype":"success"/);
  record('acme/app#63', 'intake', 'started', {});
  assert.throws(() => startRun('acme/app#63', stubEnv, () => assert.fail('no spawn')), /already has an active run/, 'it finished cleanly: active for its own reasons');
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
  assert.deepEqual(JSON.parse(req('POST', '/api/sessions/open', { id: 'not-a-desktop-id' }).body), { resume: { command: 'claude --resume not-a-desktop-id' } }, 'no desktop id: how to resume it');
  assert.match(JSON.parse(req('POST', '/api/sessions/open', { id: '--resume x' }).body).error, /id must be a session id/);
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
function fakePty(spawnError, pid) {
  const rec = {};
  return { rec, spawn(file, args, opts) {
    if (spawnError) throw new Error(spawnError);
    Object.assign(rec, { file, args, cwd: opts.cwd, env: opts.env });
    let data, exit;
    setTimeout(() => data('ready\r\n'), 5);
    return { pid, onData: (f) => { data = f; }, onExit: (f) => { exit = f; }, write: (x) => { (rec.writes ||= []).push(x); data(`echo:${x}`); if (x === 'exit\r') exit({ exitCode: 0 }); }, resize: (c, r) => { rec.size = [c, r]; }, kill: () => exit({ exitCode: null }) };
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
  assert.throws(() => terminalSession({ repo: 'acme/term', issue: 92, resume: 'stub-session' }, stubEnv, modules), /already has a running session/, 'never two claudes on one harness session');
  end = finished(run); run.stop(); await end;
  assert.ok(resumable().includes('acme/term#92'));
  const s = terminalSession({ repo: 'acme/term', resume: 'stub-session' }, stubEnv, modules); // no issue in the body: the label is the session's
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([s.label, pty.rec.args, fs.realpathSync(pty.rec.cwd)], ['acme/term#92', ['--resume', 'stub-session'], fs.realpathSync(clone)]);
  assert.throws(() => terminalSession({ repo: 'acme/term', resume: 'stub-session' }, stubEnv, modules), /acme\/term#92 already has a running session/);
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
  assert.equal(pty.rec.env.NoDefaultCurrentDirectoryInExePath, '1'); // the shim's bare `node` is never taken from the worktree
  assert.equal(pty.rec.env.PATH, stubEnv.PATH); // merged over the host's env, not instead of it
  s.stop(); await finished(s);
});

test('a stop while node-pty or the SDK loads is kept: nothing starts', async () => {
  const pty = fakePty(), sdk = fakeSdk();
  const t = startSession(claude, { mode: 'terminal' }, { cwd: home, modules: { [PTY]: pty } }); t.stop();
  const q = startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, modules: { [SDK]: sdk } }); q.stop();
  assert.deepEqual([(await finished(t)).at(-1).code, (await finished(q)).at(-1).code], ['stopped', 'stopped']);
  assert.deepEqual([pty.rec.file, sdk.rec.q], [undefined, undefined]);
});

test('sdk mode: the CLI the SDK spawns goes through our spawn, so its pid reaches onPid (the claim)', async () => {
  const pids = [], children = [];
  const sdk = { async *query(q) {
    sdk.opts = q.options;
    const child = q.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.stderr.write("warn"); setTimeout(() => {}, 200)'], env: process.env, signal: new AbortController().signal });
    children.push(child);
    yield { type: 'system', subtype: 'init', session_id: 'sdk-2' };
    await new Promise((r) => child.on('exit', r));
    yield { type: 'result', subtype: 'success' };
  } };
  const s = startSession(claude, { mode: 'sdk', prompt: 'x' }, { cwd: home, env: stubEnv, modules: { [SDK]: sdk }, onPid: (p) => pids.push(p) });
  assert.equal((await finished(s)).at(-1).code, 0);
  assert.deepEqual(pids, [children[0].pid]);
  assert.notEqual(pids[0], process.pid, 'the CLI, not this process');
  assert.equal(sdk.opts.mcpServersDelivery, 'initialize', "MCP servers' env and headers stay off the CLI's argv");
});

test('sdk mode: the host env reaches the SDK, and a failed result exits 1', async () => {
  const sdk = fakeSdk(), env = { ...stubEnv, FACTORY_MARK: 'x' };
  await finished(startSession(claude, { mode: 'sdk', prompt: 'hi' }, { cwd: home, env, modules: { [SDK]: sdk } }));
  assert.deepEqual(sdk.rec.q.options.env, env);
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
