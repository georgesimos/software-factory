// F approve (docs/plans/local-first.md §2.2, D4): a local item has no verifiable author, so its spec passes only once a person
// approves exactly that spec, from their own terminal. GitHub Issues keeps its own channel, a trusted "/factory approve" comment.
// What it stops is the run's own agent approving its own spec by mistake or by following an item's text. It is a speed bump, not a
// security boundary: an agent determined to get past it can (see ttyAsk), so a local item's merge never rests on it (always trustBroken).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { derive } from './derive.ts';
import { read, record, runDir } from './log.ts';
import { parseRun } from './github.ts';
import { trackerOf } from './workspace.ts';
import { humanOnly } from './projectset.ts';
import { whoami } from './rules.ts';
import type { FactoryEvent, Run } from './types.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** GitHub Issues approves through its trusted comments; every other tracker (or a broken config) needs F approve. */
const ownChannel = (repo: string) => { try { return trackerOf(repo) === 'github-issues'; } catch { return false; } };
/** A tracker item's run (owner/repo#N) off GitHub Issues; F sync's imports of branches (owner/repo:branch) are not specced. */
const needsF = (run: string) => { try { return !ownChannel(parseRun(run).repo); } catch { return false; } };
/** Control characters (C0 and C1, keeping tab and newline) out of what goes to the terminal: an item's title or spec can't move the cursor or retitle the window. */
export const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** The spec put to the user: all of DIR/spec.md, a plain file, never empty. */
function specOf(run: string) {
  const f = path.join(runDir(run), 'spec.md');
  let text = '';
  try { if (fs.lstatSync(f).isFile()) text = fs.readFileSync(f, 'utf8'); } catch { /* missing: refused below */ }
  if (!text.trim()) throw new Error(`${run} has no spec to approve: write DIR/spec.md (F dir ${run}) first`);
  return { text, sha: sha(text) };
}

/** record()'s step on "spec awaiting-approval" off GitHub Issues: F, not the payload, says which spec.md was put to the user. */
export function specAsked(run: string, p: Partial<FactoryEvent>): Partial<FactoryEvent> {
  if (!needsF(run)) return p;
  if (typeof p.spec !== 'string' || !p.spec.trim()) throw new Error('"spec awaiting-approval" needs {"spec":"one line"}: a non-empty string');
  return { ...p, specSha: specOf(run).sha };
}

/** The spec put to the user (the latest awaiting-approval), the F approve record after it, and whether a spec already passed on it. */
export function pending(r: Run) {
  const i = r.events.findLastIndex((e) => e.stage === 'spec' && e.status === 'awaiting-approval'), after = i < 0 ? [] : r.events.slice(i + 1);
  const j = after.findIndex((e) => e.stage === 'spec' && e.status === 'decided');
  return { asked: r.events[i], said: after[j], used: j >= 0 && after.slice(j + 1).some((e) => e.stage === 'spec' && e.status === 'passed') };
}

/** record()'s check on "spec passed": off GitHub Issues, only after F approve of exactly the spec that was put to the user, once. */
export function specApproved(run: string, p: { spec?: unknown }) {
  if (!needsF(run)) return;
  const r = derive(read())[run], { asked, said, used } = r ? pending(r) : { asked: undefined, said: undefined, used: false };
  const why = !asked ? 'it was never put to you (record "spec awaiting-approval" first)' : !said ? 'you have not approved it'
    : used ? 'that approval was already used' : !asked.specSha || said.specSha !== asked.specSha || current(run) !== asked.specSha || (p.spec !== undefined && p.spec !== asked.spec) ? 'it is not the spec you approved' : null;
  if (why) throw new Error(`${run}'s spec can't pass: ${why}. A local item's spec needs your approval: run F approve ${run} in your own terminal`);
}
const current = (run: string) => { try { return specOf(run).sha; } catch { return undefined; } };

/** record()'s check on "build started", and worktree()'s: off GitHub Issues, building waits for a "spec passed" (so an approved
 *  spec) after the latest intake or ask, and for DIR/spec.md to still be the approved one. */
export function specCleared(run: string, doing: string) {
  if (!needsF(run)) return;
  const r = derive(read())[run];
  if (r?.imported) return; // F sync's import of work done outside the factory: nothing was specced
  const ev = r?.events ?? [], i = ev.findLastIndex((e) => e.stage === 'intake' && e.status === 'started' || e.stage === 'spec' && e.status === 'awaiting-approval');
  const passed = i >= 0 && ev.slice(i + 1).some((e) => e.stage === 'spec' && e.status === 'passed'), asked = r && pending(r).asked;
  const why = !passed ? 'its spec has not passed since it was last put to you' : current(run) !== asked?.specSha ? 'DIR/spec.md is not the spec you approved' : null;
  if (why) throw new Error(`${run} can't ${doing}: ${why}. A local item's spec needs your approval: run F approve ${run} in your own terminal, then record "spec passed"`);
}

/** Asks on the controlling terminal, never stdin, so piped input can't answer it. An agent's shell tool has no terminal: checked
 *  for Claude Code in the desktop app (opening /dev/tty fails with ENXIO).
 *  shortcut: a speed bump, not a security boundary. An agent can get a terminal (script -q /dev/null gives it a pty) and clear the
 *  session variables humanOnly reads, or append a "spec decided" line to events.jsonl itself; the 5c dialog won't stop either.
 *  Merges stay safe because a local item is always trustBroken. The claude CLI started from a terminal, and codex, are unchecked.
 *  Upgrade when approval has to hold against the agent: a channel it can't reach (a signed record, or the desktop app's own store). */
export function ttyAsk(prompt: string) {
  const [inp, out] = process.platform === 'win32' ? ['CONIN$', 'CONOUT$'] : ['/dev/tty', '/dev/tty'];
  let i: number, o: number;
  try { i = fs.openSync(inp, 'r'); o = fs.openSync(out, 'w'); } catch { throw new Error('approval needs your terminal, and this process has none: run F approve in your own terminal, not from an agent or a script'); }
  try {
    fs.writeSync(o, prompt);
    let line = '';
    for (const b = Buffer.alloc(1); fs.readSync(i, b, 0, 1, null) === 1 && b[0] !== 10;) line += b.toString();
    return line.replace(/\r$/, '');
  } finally { fs.closeSync(i); fs.closeSync(o); }
}

/** F approve RUN: yours only (refused in an agent session), typed at your terminal, for the spec a local item's run is waiting on. */
export function approveSpec(run: string, ask: (prompt: string) => string = ttyAsk) {
  humanOnly('approving a spec');
  const { repo } = parseRun(run);
  if (ownChannel(repo)) throw new Error(`${repo}'s items are on GitHub Issues: approve with a "/factory approve" comment on the issue from a trusted account`);
  const r = derive(read())[run];
  if (r?.outcome !== 'awaiting-approval') throw new Error(`${run} is not awaiting approval`);
  const { asked, said } = pending(r); // awaiting-approval: the outcome comes from that event
  if (said) throw new Error(`${run}'s spec is already approved: the run goes on with "spec passed"`);
  const { text, sha: h } = specOf(run), code = h.slice(0, 7);
  if (asked!.specSha !== h) throw new Error(`${run}'s DIR/spec.md changed after it was put to you: the run records "spec awaiting-approval" again`);
  const typed = ask(clean(`${run}: ${r.title ?? ''}\n\nSpec (DIR/spec.md):\n${text}\n\nWhy it waits: ${(asked!.reasons as string[] | undefined ?? []).join('; ') || '-'}\n\nType ${code} to approve this spec (anything else cancels): `));
  if (typed.trim() !== code) throw new Error('not approved: what you typed did not match');
  const who = whoami('approving a spec');
  record(run, 'spec', 'decided', { decision: 'approve', by: who.by, via: who.via, specSha: h });
  return { run, decision: 'approve', by: who.by, via: who.via };
}
