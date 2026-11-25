// F approve (docs/plans/local-first.md §2.2, D4): a local item has no verifiable author, so its spec passes only once a person
// approves exactly that spec, from their own terminal. GitHub Issues keeps its own channel, a trusted "/factory approve" comment.
// What it stops is the run's own agent approving its own spec by mistake or by following an item's text. It is a speed bump, not a
// security boundary: an agent determined to get past it can (see ttyAsk). F approve RUN --merge (local-first PR 7) uses the same
// bump, and on the git host a merge does rest on it: nobody there is verified (D4), so the user's typed approval is all there is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { derive } from './derive.ts';
import { read, record, runDir } from './log.ts';
import { merge, parseRun } from './github.ts';
import { hostOf, trackerOf } from './workspace.ts';
import { humanOnly } from './projectset.ts';
import { LOCAL_BY, whoami } from './rules.ts';
import type { FactoryEvent, Run } from './types.ts';
import type { Facts } from './gate.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** GitHub Issues approves through its trusted comments; every other tracker (or a broken config) needs F approve. */
const ownChannel = (repo: string) => { try { return trackerOf(repo) === 'github-issues'; } catch { return false; } };
/** A tracker item's run (owner/repo#N) off GitHub Issues; F sync's imports of branches (owner/repo:branch) are not specced. */
const needsF = (run: string) => { try { return !ownChannel(parseRun(run).repo); } catch { return false; } };
/** Control characters (C0 and C1, keeping tab and newline) out of what goes to the terminal: an item's title or spec can't move the cursor or retitle the window. */
export const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ''); // and bidi, zero-width, soft-hyphen and line/paragraph separator marks, which can reorder or hide what the spec says

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
  const ASK = 'record "spec awaiting-approval" again, so the user can approve this one with F approve';
  const [why, next] = !asked ? ['it was never put to you', `record "spec awaiting-approval", then the user runs F approve ${run} in their own terminal`]
    : !said ? ['you have not approved it', `the user runs F approve ${run} in their own terminal`]
    : used ? ['that approval was already used', ASK]
    : !asked.specSha || said.specSha !== asked.specSha || current(run) !== asked.specSha ? ['DIR/spec.md is not the spec you approved', `put back the approved spec.md, or ${ASK}`]
    : p.spec !== undefined && p.spec !== asked.spec ? ['it is not the spec you approved', 'pass the approved spec line, or none'] : [null, null];
  if (why) throw new Error(`${run}'s spec can't pass: ${why}. Next: ${next}`);
}
/** The sha of DIR/spec.md now (or of text read from it), or undefined. */
export const current = (run: string, text?: string) => { if (text !== undefined) return sha(text); try { return specOf(run).sha; } catch { return undefined; } };

/** record()'s check on "build started", and worktree()'s: off GitHub Issues, building waits for a "spec passed" (so an approved
 *  spec) after the latest intake or ask, and for DIR/spec.md to still be the approved one. */
export function specCleared(run: string, doing: string) {
  if (!needsF(run)) return;
  const r = derive(read())[run];
  if (r?.imported) return; // F sync's import of work done outside the factory: nothing was specced
  const ev = r?.events ?? [], i = ev.findLastIndex((e) => e.stage === 'intake' && e.status === 'started' || e.stage === 'spec' && e.status === 'awaiting-approval');
  const passed = i >= 0 && ev.slice(i + 1).some((e) => e.stage === 'spec' && e.status === 'passed'), asked = r && pending(r).asked;
  const [why, next] = !passed ? ['its spec has not passed since it was last put to you', `F approval ${run} says where it stands: the spec is put to the user ("spec awaiting-approval"), they run F approve ${run} in their own terminal, then "spec passed"`]
    : current(run) !== asked?.specSha ? ['DIR/spec.md is not the spec you approved', 'put back the approved spec.md, or record "spec awaiting-approval" again, so the user can approve this one with F approve'] : [null, null];
  if (why) throw new Error(`${run} can't ${doing}: ${why}. Next: ${next}`);
}

/** Asks on the controlling terminal, never stdin, so piped input can't answer it. An agent's shell tool has no terminal: checked
 *  for Claude Code in the desktop app (opening /dev/tty fails with ENXIO).
 *  shortcut: a speed bump, not a security boundary. An agent can get a terminal (script -q /dev/null gives it a pty) and clear the
 *  session variables humanOnly reads, or append a "spec decided" line to events.jsonl itself; the 5c dialog won't stop either.
 *  On the git host a merge rests on it too (F approve RUN --merge): that is D4's choice, the user being all there is. The claude CLI started from a terminal, and codex, are unchecked.
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

/** What F approve puts to the user for a run, after every refusal F approve makes (an agent session, a GitHub Issues item, a
 *  run not waiting, an approved spec, a spec.md changed since the ask). The desktop dialog shows the same. */
export function specPending(run: string) {
  humanOnly('approving a spec');
  const { repo } = parseRun(run);
  if (ownChannel(repo)) throw new Error(`${repo}'s items are on GitHub Issues: approve with a "/factory approve" comment on the issue from a trusted account`);
  const r = derive(read())[run];
  if (r?.outcome !== 'awaiting-approval') throw new Error(`${run} is not awaiting approval`);
  const { asked, said } = pending(r); // awaiting-approval: the outcome comes from that event
  const { text, sha: h } = specOf(run);
  if (asked!.specSha !== h) throw new Error(`${run}'s DIR/spec.md changed after it was put to you${said ? ' and approved' : ''}: the run records "spec awaiting-approval" again, then you approve that`);
  if (said) throw new Error(`${run}'s spec is already approved: the run goes on with "spec passed"`);
  return { run, title: clean(r.title ?? ''), spec: clean(text), sha: h, code: h.slice(0, 7), reasons: (asked!.reasons as string[] | undefined ?? []).map((x) => clean(String(x))) };
}

/** The local items' specs waiting for approval: what the desktop app's Run → Approve… lists. Never a GitHub Issues run. */
export const awaitingSpecs = () => Object.values(derive(read()))
  .filter((r) => r.outcome === 'awaiting-approval' && needsF(r.id) && !pending(r).said).map((r) => ({ run: r.id, title: clean(r.title ?? '') }));

/** F approve RUN: yours only (refused in an agent session), typed at your terminal, for the spec a local item's run is waiting on. */
export function approveSpec(run: string, ask: (prompt: string) => string = ttyAsk) {
  const p = specPending(run);
  const typed = ask(`${run}: ${p.title}\n\nSpec (DIR/spec.md):\n${p.spec}\n\nWhy it waits: ${p.reasons.join('; ') || '-'}\n\nType ${p.code} to approve this spec (anything else cancels): `);
  if (typed.trim() !== p.code) throw new Error('not approved: what you typed did not match');
  const who = whoami('approving a spec');
  record(run, 'spec', 'decided', { decision: 'approve', by: who.by, via: who.via, specSha: p.sha });
  return { run, decision: 'approve', by: who.by, via: who.via };
}

/** The desktop app's Run → Approve…, once its dialog was confirmed for the spec with hash `sha` (local-first §2.2 step 3): the
 *  checks again (the log may have moved while the dialog was open), then the same record, by the OS user, unverified. */
export function approveSpecDesktop(run: string, sha: string, user = () => os.userInfo().username) {
  const p = specPending(run);
  if (p.sha !== sha) throw new Error(`${run}'s spec changed while the dialog was open: nothing was approved`);
  const by = user();
  if (!LOCAL_BY.test(by)) throw new Error('cannot tell who is approving a spec: there is no OS user name');
  // via 'local' as whoami's OS user: unverified everywhere, and scrubbed from a published page (isLocal); channel says where.
  record(run, 'spec', 'decided', { decision: 'approve', by, via: 'local', channel: 'desktop', specSha: sha });
  return { run, decision: 'approve', by, via: 'local', channel: 'desktop' };
}

/** F approve RUN --merge (local-first §3): yours only, typed at your terminal, for the reviewed commit a run's merge waits on (F merge
 *  said await-approval), then F merge in the same command, which merges only if decide() now says merge. On GitHub, a verified login. */
export function approveMerge(run: string, ask: (prompt: string) => string = ttyAsk) {
  humanOnly('approving a merge');
  const r = derive(read())[run], sha = r?.reviewedSha;
  if (r?.decision?.action !== 'await-approval' || !sha) throw new Error(`${run} is not waiting for a merge approval: F merge ${run} says where it stands`);
  const who = whoami('approving a merge');
  if (hostOf(parseRun(run).repo) === 'github' && who.via !== 'github') throw new Error('approving a merge on a GitHub project needs a verified login (gh auth login)');
  const f = (r.events.findLast((e) => e.stage === 'approve' && e.status === 'decided')?.facts ?? {}) as Facts, files = (f.files ?? []).map((x) => clean(String(x)));
  const code = sha.slice(0, 7);
  const typed = ask(`${run}: ${clean(r.title ?? '')}\n\nReviewed commit ${sha}: +${f.additions ?? '?'} -${f.deletions ?? '?'} in ${files.length} file(s)\n${files.slice(0, 40).join('\n')}${files.length > 40 ? `\n... and ${files.length - 40} more` : ''}\n\nWhy it waits: ${(r.decision.reasons ?? []).map((x) => clean(String(x))).join('; ')}\n\nType ${code} to approve merging exactly this commit (anything else cancels): `);
  if (typed.trim() !== code) throw new Error('not approved: what you typed did not match');
  record(run, 'approve', 'passed', { by: who.by, via: who.via, sha });
  return merge(run);
}
