// Local tracker (docs/plans/local-first.md D3, D4): each item is a markdown file in the clone's untracked .factory/issues/,
// <N>.md, never committed and never pushed. Front matter holds title, state and labels; the body is written as GitHub Issues
// writes it (render), so "Depends on #3" and the hidden key marker read the same. A file has no verifiable author: every
// item is untrusted (association NONE), so its spec waits for F approve, and there is no trust() for facts() to read.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../hosts/index.ts';
import type { Comment, Created, Item, OpenIssue, TrackerItem } from './index.ts';
import { dependencies as fromBody, misfit, render } from './github-issues.ts';

export const id = 'local';

const MARK = /<!-- factory-key: ([a-z0-9][a-z0-9-]*) -->/;
/** The clone's .factory/issues, refused when it could lead elsewhere or isn't the user's own: a symlinked .factory or
 *  .factory/issues (a repo can commit one), or items git tracks (they came with the repo, so they are not local items). */
function dirOf({ git }: Ctx, at?: string) {
  if (!at) throw new Error('tracker "local" needs the project\'s clone: attach it with F sync');
  for (const p of ['.factory', path.join('.factory', 'issues')]) {
    let s: fs.Stats | undefined;
    try { s = fs.lstatSync(path.join(at, p)); } catch { /* not there yet */ }
    if (s && !s.isDirectory()) throw new Error(`${p} in the clone is not a plain folder (a symlink or a file): local items are never read or written through it`);
  }
  // icase: on macOS and Windows a committed .Factory/Issues/ is the same folder
  if (git('-C', at, 'ls-files', '--', ':(icase).factory/issues').trim()) throw new Error('.factory/issues has files tracked by git: they came with the repo, so they are not your local items. Untrack them (git rm -r --cached .factory/issues) or move them');
  return path.join(at, '.factory', 'issues');
}
const isLink = (f: string) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };
const val = (s: string) => { try { return JSON.parse(s) as unknown; } catch { return s.trim(); } }; // written as JSON; a hand edit may be plain text

// A regular file only, opened without following a link (O_NOFOLLOW where the platform has it): an item never reads another file.
function readItem(file: string) {
  let s: fs.Stats | undefined;
  try { s = fs.lstatSync(file); } catch { /* below */ }
  if (!s?.isFile()) throw new Error(`${path.basename(file)} in .factory/issues is not a plain file (missing, a symlink or a folder): it is never read as an item`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let raw: string;
  try { raw = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  const text = raw.replace(/\r\n/g, '\n'), m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text), meta: Record<string, unknown> = {};
  for (const l of (m?.[1] ?? '').split('\n')) { const k = /^([\w-]+):\s*(.*)$/.exec(l); if (k) meta[k[1]!] = val(k[2]!); }
  return { title: String(meta.title ?? ''), state: String(meta.state ?? 'open'), labels: Array.isArray(meta.labels) ? meta.labels.map(String) : [], body: (m ? m[2]! : text).trim() };
}
const all = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^\d+\.md$/.test(f))
  .map((f) => ({ id: f.slice(0, -3), ...readItem(path.join(dir, f)) })).sort((a, b) => +a.id - +b.id);

/** Makes git ignore .factory/issues/ in the clone through info/exclude (the worktree-safe path git gives), never the tracked
 *  .gitignore; only the items, since other tools keep their own config in .factory/. The line goes in once. */
const IGNORE = '/.factory/issues/';
export function exclude({ git }: Ctx, at: string) {
  try { git('-C', at, 'check-ignore', '-q', '.factory/issues/1.md'); return; } catch { /* not ignored, or check-ignore failed: below */ }
  const f = path.resolve(at, git('-C', at, 'rev-parse', '--git-path', 'info/exclude').trim()), had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (had.split(/\r?\n/).includes(IGNORE)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${had && !had.endsWith('\n') ? '\n' : ''}${IGNORE}\n`);
}

/** Writes the next <N>.md. An exclusive create, so two F processes never take the same N: the second moves on to N+1. */
export function newItem(ctx: Ctx, { path: at, title, body = '', labels = ['factory:ready'] }: { path?: string; title: string; body?: string; labels?: string[] }) {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error('an item needs a one-line title');
  const dir = dirOf(ctx, at);
  exclude(ctx, at!); // dirOf threw without it
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: ${JSON.stringify(title.trim())}\nstate: open\nlabels: ${JSON.stringify(labels)}\n---\n\n${body.trim()}\n`;
  for (let n = Math.max(0, ...all(dir).map((i) => +i.id)) + 1; ; n++) {
    if (!Number.isSafeInteger(n)) throw new Error(`item numbers in .factory/issues ran past ${Number.MAX_SAFE_INTEGER}: remove the file with the huge number`);
    try { fs.writeFileSync(path.join(dir, `${n}.md`), text, { flag: 'wx' }); return { id: String(n), file: path.join(dir, `${n}.md`) }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

export function createIssues(ctx: Ctx, { path: at, items, existing = {}, onCreated = () => {}, ready = true }: { repo: string; path?: string; items: Item[]; existing?: Record<string, { id: string; url?: string | undefined }>; onCreated?: (r: Created) => void; ready?: boolean }): Created[] {
  const found: Record<string, string> = {};
  for (const i of all(dirOf(ctx, at))) { const k = MARK.exec(i.body)?.[1]; if (k && !found[k] && !misfit(k, i.body)) found[k] = i.id; } // local items have no author: all are untrusted anyway
  const ids: Record<string, string> = {}, titles = Object.fromEntries(items.map((it) => [it.key, it.title]));
  return items.map((it) => {
    const have = existing[it.key]?.id ?? found[it.key];
    if (have) { ids[it.key] = have; return { key: it.key, id: have, created: false }; }
    const n = newItem(ctx, { path: at, title: it.title, body: render(it, ids, titles), labels: it.kind === 'epic' ? ['factory:epic'] : ready ? ['factory:ready'] : [] }).id;
    ids[it.key] = n;
    const r = { key: it.key, id: n, created: true };
    onCreated(r);
    return r;
  });
}

export const listOpen = (ctx: Ctx, { path: at }: { repo: string; path?: string }): OpenIssue[] =>
  all(dirOf(ctx, at)).filter((i) => i.state === 'open').map((i) => ({ id: i.id, title: i.title, labels: i.labels, key: MARK.exec(i.body)?.[1] || null, body: i.body }));

export const dependencies = fromBody;

export function getItem(ctx: Ctx, { path: at, id: n }: { repo: string; path?: string; id: string }): TrackerItem {
  const file = path.join(dirOf(ctx, at), `${n}.md`);
  if (!/^\d+$/.test(n) || !fs.existsSync(file) && !isLink(file)) throw new Error(`no item ${n} in .factory/issues: write one with F item new`);
  const i = readItem(file);
  return { id: n, title: i.title, author: '', association: 'NONE', state: i.state, isChangeRequest: false, body: i.body };
}
export const comments = (): Comment[] => [];
export const ensureLabels = (): string[] => []; // a label is a word in the front matter: nothing to create
export const comment = () => ({ posted: false, detail: 'local items have no comments: the reason is in the run\'s events and the dashboard' });
/** Rewrites the item's front matter with the new labels (title, state and labels; the body as it was), without following a link. */
export function label(ctx: Ctx, { path: at, id: n, add = [], remove = [] }: { repo: string; path?: string; id: string; add?: string[]; remove?: string[] }) {
  if (!/^\d+$/.test(n)) throw new Error(`no item ${n} in .factory/issues`);
  const file = path.join(dirOf(ctx, at), `${n}.md`), i = readItem(file);
  const labels = [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add])];
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.writeFileSync(fd, `---\ntitle: ${JSON.stringify(i.title)}\nstate: ${i.state}\nlabels: ${JSON.stringify(labels)}\n---\n\n${i.body}\n`); } finally { fs.closeSync(fd); }
  return { labelled: true };
}
