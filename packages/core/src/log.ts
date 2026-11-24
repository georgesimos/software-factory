import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STAGES, STATUSES, TERMINAL, VERIFIER_KEYS } from './constants.ts';
import { cleanup, wtInfo } from './workspace.ts';
import { runnerStamp } from './review.ts';
import { withMeasured } from './burn.ts';
import { derive, validateReview, validateUsage } from './derive.ts';
import { harnesses } from '../../adapters/harnesses/index.ts';
import { specApproved, specAsked, specCleared } from './approve.ts';
import type { FactoryEvent, Run } from './types.ts';

// The dashboard renderer, registered by packages/server when it loads. Core alone (no server) skips the render.
export const dashboard: { render: () => unknown } = { render: () => undefined }; // server.ts sets render(), which returns the page's path

// One mutable object, not `let`s: once code moves into packages, an importer cannot reassign a binding (docs/plans/split.md S1): where F reads and writes, and which binaries it runs.
// gh/git are overridable only so the self-test can stub GitHub; projects: demo and test point it at fixture transcripts.
export const io: { dir: string; gh: string; git: string; projects: string | null } = { dir: process.env.FACTORY_DIR || path.join(os.homedir(), '.claude', 'factory'), gh: process.env.FACTORY_GH || 'gh', git: process.env.FACTORY_GIT || 'git', projects: null };
export const REAL_DIR = path.resolve(os.homedir(), '.claude', 'factory'); // at load: tests swap HOME in-process later
// Every state-dir path goes through here, so no test (FACTORY_TEST) can read or write the real ~/.claude/factory.
export const stateDir = () => {
  if (process.env.FACTORY_TEST && path.resolve(io.dir) === REAL_DIR) throw new Error(`FACTORY_TEST is set: refusing the real state dir ${io.dir}; set FACTORY_DIR to a temp dir`);
  return io.dir;
};
export const log = () => path.join(stateDir(), 'events.jsonl');
export const factoryDir = () => stateDir();
export const runDir = (run: string) => path.join(stateDir(), run.replace(/[^a-z0-9]+/gi, '-'));
export function read(): FactoryEvent[] {
  try {
    return fs.readFileSync(log(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}
export const HOST_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // a Claude desktop session id
export function record(run: string, stage: string, status: string, payload: Partial<FactoryEvent> = {}, cli?: { fallback?: unknown }): FactoryEvent { // cli: {fallback?} when the orchestrator reports a step; in-process records (sync, demo) get no runner
  if (!run) throw new Error('missing run id');
  if (String(run).endsWith(':project')) throw new Error('project runs are recorded by "new", "issues create", "loop" and "retire", not by hand');
  if (!STAGES.includes(stage)) throw new Error(`unknown stage "${stage}" (${STAGES.join('|')})`);
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}" (${STATUSES.join('|')})`);
  const prior = status === 'merged' ? derive(read())[run] : undefined; // sync records a human's merge of an escalated run (#21); F event owns neither
  if (status === 'merged' && prior?.decision?.action !== 'merge' && !(stage === 'approve' && payload.by === 'human' && prior?.outcome === 'escalated')) throw new Error('refusing "merged": the recorded decision is not merge');
  if (stage === 'review' && payload.axis !== undefined) validateReview(run, payload, status);
  if (stage === 'spec' && status === 'passed') specApproved(run, payload); // a local item's spec: only after F approve
  if (stage === 'spec' && status === 'awaiting-approval') payload = specAsked(run, payload); // and F hashes what is asked
  if (stage === 'build' && status === 'started') specCleared(run, 'start building'); // and nothing builds before it passed
  if (stage === 'review' && payload.role !== undefined) {
    if (payload.role !== 'verifier' || payload.axis !== undefined) throw new Error('role must be "verifier", without an axis');
    const extra = Object.keys(payload).filter((k) => !VERIFIER_KEYS.includes(k));
    if (extra.length) throw new Error(`verifier payload has unknown fields: ${extra.join(', ')}`);
  }
  payload = validateUsage(payload);
  const { hostSessionId: _forged, ...own } = payload; payload = own; // the desktop session comes from the environment, never a payload
  const me = stage === 'ship' ? null : harnesses.find((h) => h.current?.()); // the harness F runs inside, if any; lets the UI link back to the driving session
  const host = me?.id === 'claude-code' ? process.env.CLAUDE_CODE_HOST_SESSION_ID : undefined; // the Claude desktop app's id for that session (#26); CLAUDE_CODE_SESSION_ID is the CLI transcript's
  const ev = { ts: new Date().toISOString(), ...payload, ...(me ? { harness: me.id, sessionId: (me.current as () => string)(), ...(host && HOST_ID.test(host) && { hostSessionId: host }), cwd: process.cwd() } : {}), ...(cli && runnerStamp(run, stage, payload.axis, cli.fallback, payload.role)), run, stage, status };
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(log(), JSON.stringify(ev) + '\n');
  if (TERMINAL.includes(status) || status === 'needs-info') { // a finished (or parked) run gives back its worktree
    try { const c = cleanup(run); if (c.startsWith('kept')) console.error(`factory: ${c}`); } catch (e) { console.error(`factory: worktree cleanup failed: ${(e as Error).message}`); }
  }
  dashboard.render();
  return ev;
}
// Moves finished runs older than `days` out of the live log into compact summaries, so derive/render stay fast.
export function archive(days = 14) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const events = read();
  const runs = withMeasured(derive(events), events); // measured burn is kept in the summary: the archive drops most events
  const old = Object.values(runs).filter((r) => TERMINAL.includes(r.outcome) && r.updated < cutoff && !wtInfo(r.id));
  if (!old.length) return { archived: 0 };
  const ids = new Set(old.map((r) => r.id));
  // events: the last five, notes left out (their events and texts) so they never crowd out how the run ended
  const sessionEvents = (r: Run) => r.events.filter((e) => e.sessionId).map((e) => ({ ts: e.ts, stage: e.stage, status: e.status, sessionId: e.sessionId }));
  fs.appendFileSync(archiveFile(), old.map((r) => JSON.stringify({ ...r, notes: undefined, events: r.events.filter((e) => e.stage !== 'note').slice(-5), sessionEvents: sessionEvents(r), archived: true })).join('\n') + '\n');
  const tmp = log() + '.tmp'; // write-then-rename so a crash never leaves a half log
  fs.writeFileSync(tmp, events.filter((e) => !ids.has(e.run)).map((e) => JSON.stringify(e)).join('\n') + (events.length > ids.size ? '\n' : ''));
  fs.copyFileSync(log(), log() + '.bak');
  fs.renameSync(tmp, log());
  dashboard.render();
  return { archived: old.length };
}
export const archiveFile = () => path.join(stateDir(), 'archive.jsonl');
export const sessionsFile = () => path.join(stateDir(), 'sessions.json');
export const readArchive = (): Run[] => { try { return fs.readFileSync(archiveFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
