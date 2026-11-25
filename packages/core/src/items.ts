// A run's tracker item, written by F (local-first PR 6b), so SKILL.md names no tracker tool. F labels creates the factory's
// labels, F label adds or removes one on the run's own item, F comment posts intake's rejection or questions from the
// recorded event, F split creates the children, and F similar lists open items that may be duplicates. The target is
// always the run's own item; the text is F's or the recorded event's, through the same scrub as F escalate's comment.
import { TRUSTED } from './constants.ts';
import { cut, driven } from './changes.ts';
import { marked, NO_MARK } from './project.ts';
import { current } from './approve.ts';
import { adapterCtx, parseRun } from './github.ts';
import fs from 'node:fs';
import path from 'node:path';
import { record, runDir } from './log.ts';
import { scrubText, unmention } from './scrub.ts';
import { projects, trackerFn, trackerOf } from './workspace.ts';

const where = (repo: string) => { const at = projects()[repo]?.path; return at ? { path: at } : {}; };
const clean = (s: string) => unmention(scrubText(s));

/** The labels F label sets, and who sets each of the others. */
export const BY_HAND = ['factory:in-progress', 'factory:needs-info', 'factory:rejected', 'factory:needs-approval'];
const OWNED: Record<string, string> = { 'factory:ready': 'F split (a trusted parent\'s children) or a human', 'factory:merged': 'F merge and F sync',
  'factory:needs-human': 'F escalate and F revert', 'factory:epic': 'F issues create' };

export const labels = (repo: string) => ({ labels: trackerFn(trackerOf(repo), 'ensureLabels', 'create labels')(adapterCtx(), { repo, ...where(repo) }) });

export function label(run: string, op: string, name: string) {
  if (op !== 'add' && op !== 'remove') throw new Error('usage: label RUN add|remove LABEL');
  if (!BY_HAND.includes(name)) throw new Error(OWNED[name] ? `${name} is added by ${OWNED[name]}, not by F label` : `${name} is not one of the labels F label sets: ${BY_HAND.join(', ')}`);
  driven(run);
  const { repo, n } = parseRun(run);
  return trackerFn(trackerOf(repo), 'label', 'label an item')(adapterCtx(), { repo, ...where(repo), id: n, [op]: [name] });
}

/** From the run's latest intake or spec event: the rejection reason, the needs-info questions, or a spec awaiting approval
 *  (DIR/spec.md, which F hashed when it recorded the wait, and how a maintainer answers). */
export function comment(run: string) {
  const r = driven(run), { repo, n } = parseRun(run), e = r.events.findLast((x) => x.stage === 'intake' || x.stage === 'spec');
  let spec = '', raw = '';
  if (e?.stage === 'spec' && e.status === 'awaiting-approval') try { raw = fs.readFileSync(path.join(runDir(run), 'spec.md'), 'utf8'); spec = raw.trim(); } catch { /* refused below */ }
  const qs = Array.isArray(e?.questions) && e.questions.length && e.questions.every((q) => typeof q === 'string' && q.trim()) ? (e.questions as string[]) : null;
  const body = e?.status === 'rejected' && typeof e.reason === 'string' && e.reason.trim() ? `The software factory won't build this.\n\nWhy: ${e.reason.trim()}`
    : spec ? `${spec}\n\nA maintainer can reply \`/factory approve\` or \`/factory reject\`.`
    : e?.status === 'needs-info' && qs ? ['The software factory needs more information before it can build this:', '', ...qs.map((q, i) => `${i + 1}. ${q.trim()}`), '',
      'Answer in a comment here; the factory reads new comments when it runs again.'].join('\n')
    : null;
  if (!body) throw new Error(`${run} has nothing to comment: no recorded rejection (with a reason), needs-info (with questions) or spec awaiting approval (with DIR/spec.md); record it with F event first`);
  const done = trackerFn(trackerOf(repo), 'comment', 'comment on an item')(adapterCtx(), { repo, ...where(repo), id: n, body: cut(clean(body), 'the rest is in the run\'s events') });
  // The wait again, pinned to the spec just posted: F approval on GitHub counts votes after it, for exactly that spec.md.
  if (spec && e && done.posted) record(run, 'spec', 'awaiting-approval', { spec: e.spec, ...(e.reasons && { reasons: e.reasons }), postedSha: current(run, raw) });
  return done;
}

const MAX_CHILDREN = 10, KEYS = ['title', 'body', 'acceptance'];
/** The run's children from {children:[{title, body?, acceptance[]}]}: "Part of #N" and the keys are F's, and factory:ready only
 *  when the parent (and any issue it was split from) has a trusted author, as intake recorded it. F records the split. */
export function split(run: string, input: unknown, { dryRun = false } = {}) {
  const r = driven(run), { repo, n } = parseRun(run);
  const kids = (input as { children?: unknown } | null)?.children;
  if (!Array.isArray(kids) || kids.length < 2 || kids.length > MAX_CHILDREN) throw new Error(`split needs {"children":[{"title","body","acceptance":[…]},…]}: 2 to ${MAX_CHILDREN} children`);
  const items = kids.map((c: Record<string, unknown>, i) => {
    const at = `child ${i + 1}`, extra = Object.keys(c ?? {}).filter((k) => !KEYS.includes(k));
    if (extra.length) throw new Error(`${at}: unknown field ${extra.join(', ')} (${KEYS.join(', ')})`);
    const { title, body = '', acceptance } = c ?? {};
    if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n]/.test(title)) throw new Error(`${at}: a one-line title of 1-200 characters`);
    if (typeof body !== 'string' || body.length > 20_000) throw new Error(`${at}: a body of at most 20000 characters`);
    if (!Array.isArray(acceptance) || !acceptance.length || acceptance.length > 20 || acceptance.some((a) => typeof a !== 'string' || !a.trim() || a.length > 500)) throw new Error(`${at}: acceptance needs 1 to 20 testable criteria, 1-500 characters each`);
    if (marked([title, body, ...acceptance])) throw new Error(`${at}: ${NO_MARK}`);
    return { key: `split-${n}-${i + 1}`, title: clean(title.trim()), body: `Part of #${n}\n\n${clean(body.trim())}`, acceptance: (acceptance as string[]).map((a) => clean(a.trim())) };
  });
  if (r.stage !== 'intake' || !['started', 'decided'].includes(r.status)) throw new Error(`${run} is not right after F intake: split only decides intake`); // decided: a split that stopped half way
  const ready = TRUSTED.includes(r.association) && (!r.origin || TRUSTED.includes(r.originAssociation));
  if (dryRun) return { dryRun: true, ready, children: items.map((i) => ({ key: i.key, title: i.title })) };
  // The intent, then each child as it is made or found again, one item per call: a child of a split that stops part way still
  // finds its parent at intake. The recorded list only grows (a re-intake in between keeps it), so no record drops a child.
  const keys = items.map((i) => i.key), kept = new Set(r.children || []), create = trackerFn(trackerOf(repo), 'createIssues', 'create items');
  record(run, 'intake', 'decided', { decision: 'split', keys, ...(kept.size && { children: [...kept] }) });
  const made = items.map((it) => {
    const [c] = create(adapterCtx(), { repo, ...where(repo), items: [it], ready });
    record(run, 'intake', 'decided', { decision: 'split', keys, children: [...kept.add(`${repo}#${c!.id}`)] });
    return c!;
  });
  record(run, 'intake', 'split', { children: [...kept] });
  return { ready, children: made.map((c) => ({ run: `${repo}#${c.id}`, ...(c.url && { url: c.url }), created: c.created })) };
}

/** Open items whose title or body has any of the words, most matches first; never the run's own. */
export function similar(run: string, words: string[]) {
  const { repo, n } = parseRun(run), ws = [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3))].slice(0, 10);
  if (!ws.length) throw new Error('usage: similar RUN WORD…: at least one word of 3 or more letters');
  const open = trackerFn(trackerOf(repo), 'listOpen', 'list open items')(adapterCtx(), { repo, ...where(repo) });
  const hits = open.filter((i) => i.id !== n).map((i) => ({ i, k: ws.filter((w) => `${i.title}\n${i.body ?? ''}`.toLowerCase().includes(w)).length })).filter((x) => x.k);
  hits.sort((a, b) => b.k - a.k || a.i.id.localeCompare(b.i.id, undefined, { numeric: true }));
  return { similar: hits.slice(0, 20).map(({ i }) => ({ run: `${repo}#${i.id}`, title: i.title.slice(0, 200) })), note: 'open items only: a closed duplicate is not listed' };
}
