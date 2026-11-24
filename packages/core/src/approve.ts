// F approve (docs/plans/local-first.md §2.2, D4): a local item has no verifiable author, so its spec passes only once a person
// approves exactly that spec, from their own terminal. GitHub Issues keeps its own channel, a trusted "/factory approve" comment.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { derive } from './derive.ts';
import { read, record } from './log.ts';
import { parseRun } from './github.ts';
import { trackerOf } from './workspace.ts';
import { humanOnly } from './projectset.ts';
import { whoami } from './rules.ts';
import type { Run } from './types.ts';

const sha = (s: unknown) => createHash('sha256').update(String(s ?? '')).digest('hex');
/** GitHub Issues approves through its trusted comments; every other tracker (or a broken config) needs F approve. */
const ownChannel = (repo: string) => { try { return trackerOf(repo) === 'github-issues'; } catch { return false; } };

/** The spec put to the user (the latest awaiting-approval), the F approve record after it, and whether a spec already passed on it. */
export function pending(r: Run) {
  const i = r.events.findLastIndex((e) => e.stage === 'spec' && e.status === 'awaiting-approval'), after = i < 0 ? [] : r.events.slice(i + 1);
  const j = after.findIndex((e) => e.stage === 'spec' && e.status === 'decided');
  return { asked: r.events[i], said: after[j], used: j >= 0 && after.slice(j + 1).some((e) => e.stage === 'spec' && e.status === 'passed') };
}

/** record()'s check on "spec passed": off GitHub Issues, only after F approve of exactly the spec that was put to the user, once. */
export function specApproved(run: string, p: { spec?: unknown }) {
  if (ownChannel(parseRun(run).repo)) return;
  const r = derive(read())[run], { asked, said, used } = r ? pending(r) : { asked: undefined, said: undefined, used: false };
  const why = !asked ? 'it was never put to you (record "spec awaiting-approval" first)' : !said ? 'you have not approved it'
    : used ? 'that approval was already used' : said.specSha !== sha(asked.spec) || (p.spec !== undefined && p.spec !== asked.spec) ? 'it is not the spec you approved' : null;
  if (why) throw new Error(`${run}'s spec can't pass: ${why}. A local item's spec needs your approval: run F approve ${run} in your own terminal`);
}

/** Asks on the controlling terminal, never stdin, so piped input can't answer it. An agent's shell tool has no terminal: checked
 *  for Claude Code in the desktop app (opening /dev/tty fails with ENXIO).
 *  shortcut: the claude CLI started from a terminal, and codex, are unchecked; check each before relying on it (local-first §2.2). */
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
  const asked = pending(r).asked!, h = sha(asked.spec), code = h.slice(0, 7); // awaiting-approval: the outcome comes from that event
  const typed = ask(`${run}: ${r.title ?? ''}\n\nSpec:\n${String(asked.spec ?? '(none recorded)')}\n\nWhy it waits: ${(asked.reasons as string[] | undefined ?? []).join('; ') || '-'}\n\nType ${code} to approve this spec (anything else cancels): `);
  if (typed.trim() !== code) throw new Error('not approved: what you typed did not match');
  const who = whoami('approving a spec');
  record(run, 'spec', 'decided', { decision: 'approve', by: who.by, via: who.via, specSha: h });
  return { run, decision: 'approve', by: who.by, via: who.via };
}
