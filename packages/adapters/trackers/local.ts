// Local tracker (docs/plans/local-first.md D3, D4): each item is a markdown file in the clone's untracked .factory/issues/,
// <N>.md, never committed and never pushed. Front matter holds title, state and labels; the body is written as GitHub Issues
// writes it (render), so "Depends on #3" and the hidden key marker read the same. A file has no verifiable author: every
// item is untrusted (association NONE), so its spec waits for F approve, and there is no trust() for facts() to read.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../hosts/index.ts';
import type { Comment, Created, Item, OpenIssue, TrackerItem } from './index.ts';
import { dependencies as fromBody, render } from './github-issues.ts';

export const id = 'local';

const MARK = /<!-- factory-key: ([a-z0-9][a-z0-9-]*) -->/;
const dirOf = (at?: string) => { if (!at) throw new Error('tracker "local" needs the project\'s clone: attach it with F sync'); return path.join(at, '.factory', 'issues'); };
const val = (s: string) => { try { return JSON.parse(s) as unknown; } catch { return s.trim(); } }; // written as JSON; a hand edit may be plain text

function readItem(file: string) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text), meta: Record<string, unknown> = {};
  for (const l of (m?.[1] ?? '').split('\n')) { const k = /^([\w-]+):\s*(.*)$/.exec(l); if (k) meta[k[1]!] = val(k[2]!); }
  return { title: String(meta.title ?? ''), state: String(meta.state ?? 'open'), labels: Array.isArray(meta.labels) ? meta.labels.map(String) : [], body: (m ? m[2]! : text).trim() };
}
const all = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^\d+\.md$/.test(f))
  .map((f) => ({ id: f.slice(0, -3), ...readItem(path.join(dir, f)) })).sort((a, b) => +a.id - +b.id);

/** Makes git ignore .factory/ in the clone through info/exclude (the worktree-safe path git gives), never the tracked .gitignore. */
export function exclude({ git }: Ctx, at: string) {
  try { git('-C', at, 'check-ignore', '-q', '.factory/issues/1.md'); return; } catch { /* not ignored yet */ }
  const f = path.resolve(at, git('-C', at, 'rev-parse', '--git-path', 'info/exclude').trim()), had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${had && !had.endsWith('\n') ? '\n' : ''}/.factory/\n`);
}

/** Writes the next <N>.md. An exclusive create, so two F processes never take the same N: the second moves on to N+1. */
export function newItem(ctx: Ctx, { path: at, title, body = '', labels = ['factory:ready'] }: { path?: string; title: string; body?: string; labels?: string[] }) {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error('an item needs a one-line title');
  const dir = dirOf(at);
  exclude(ctx, at!); // dirOf threw without it
  fs.mkdirSync(dir, { recursive: true });
  const text = `---\ntitle: ${JSON.stringify(title.trim())}\nstate: open\nlabels: ${JSON.stringify(labels)}\n---\n\n${body.trim()}\n`;
  for (let n = Math.max(0, ...all(dir).map((i) => +i.id)) + 1; ; n++) {
    try { fs.writeFileSync(path.join(dir, `${n}.md`), text, { flag: 'wx' }); return { id: String(n), file: path.join(dir, `${n}.md`) }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

export function createIssues(ctx: Ctx, { path: at, items, existing = {}, onCreated = () => {} }: { repo: string; path?: string; items: Item[]; existing?: Record<string, { id: string; url?: string | undefined }>; onCreated?: (r: Created) => void }): Created[] {
  const found: Record<string, string> = {};
  for (const i of all(dirOf(at))) { const k = MARK.exec(i.body)?.[1]; if (k && !found[k]) found[k] = i.id; }
  const ids: Record<string, string> = {}, titles = Object.fromEntries(items.map((it) => [it.key, it.title]));
  return items.map((it) => {
    const have = existing[it.key]?.id ?? found[it.key];
    if (have) { ids[it.key] = have; return { key: it.key, id: have, created: false }; }
    const n = newItem(ctx, { path: at, title: it.title, body: render(it, ids, titles), labels: [it.kind === 'epic' ? 'factory:epic' : 'factory:ready'] }).id;
    ids[it.key] = n;
    const r = { key: it.key, id: n, created: true };
    onCreated(r);
    return r;
  });
}

export const listOpen = (_ctx: Ctx, { path: at }: { repo: string; path?: string }): OpenIssue[] =>
  all(dirOf(at)).filter((i) => i.state === 'open').map((i) => ({ id: i.id, title: i.title, labels: i.labels, key: MARK.exec(i.body)?.[1] || null, body: i.body }));

export const dependencies = fromBody;

export function getItem(_ctx: Ctx, { path: at, id: n }: { repo: string; path?: string; id: string }): TrackerItem {
  const file = path.join(dirOf(at), `${n}.md`);
  if (!/^\d+$/.test(n) || !fs.existsSync(file)) throw new Error(`no item ${n} in .factory/issues: write one with F item new`);
  const i = readItem(file);
  return { id: n, title: i.title, author: '', association: 'NONE', state: i.state, isChangeRequest: false, body: i.body };
}
export const comments = (): Comment[] => [];
