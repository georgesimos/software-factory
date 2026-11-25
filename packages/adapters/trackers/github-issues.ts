// GitHub Issues tracker, through the logged-in `gh`. Each issue body ends with a hidden key marker, so a re-run
// (even without the local key map) finds what an interrupted run already created instead of creating it twice.
import type { Ctx } from '../hosts/index.ts';
import type { Comment, Created, Item, OpenIssue, TrackerItem } from './index.ts';

export const id = 'github-issues';

const MARK = /<!-- factory-key: ([a-z0-9][a-z0-9-]*) -->/;
const LABELS: [string, string][] = [['factory:ready', 'BFD4F2'], ['factory:epic', 'D4C5F9']];
const STAGES = ['factory:in-progress', 'factory:needs-info', 'factory:rejected', 'factory:needs-human', 'factory:merged', 'factory:needs-approval'];

export function render(it: Item, ids: Record<string, string>, titles: Record<string, string>) {
  const ref = (k: string) => { if (!ids[k]) throw new Error(`"${it.key}" refers to "${k}", which has no issue yet`); return `#${ids[k]}`; };
  const parts = [String(it.body || '').trim()];
  if (it.kind === 'epic') parts.push('## Issues\n' + (it.children || []).map((k) => `- [ ] ${ref(k)} ${titles[k]}`).join('\n'));
  else {
    parts.push('## Acceptance criteria\n' + (it.acceptance || []).map((a) => `- [ ] ${a}`).join('\n'));
    const meta = [it.dependsOn?.length ? `Depends on ${it.dependsOn.map(ref).join(', ')}` : '', it.milestone ? `Milestone: ${it.milestone}` : ''].filter(Boolean);
    if (meta.length) parts.push(meta.join('\n'));
  }
  return [...parts.filter(Boolean), `<!-- factory-key: ${it.key} -->`].join('\n\n');
}

export function createIssues({ gh }: Ctx, { repo, items, existing = {}, onCreated = () => {}, ready = true }: { repo: string; items: Item[]; existing?: Record<string, { id: string; url?: string | undefined }>; onCreated?: (r: Created) => void; ready?: boolean }): Created[] {
  for (const [name, color] of LABELS) gh('label', 'create', name, '-R', repo, '--force', '--color', color);
  const found: Record<string, { id: string; url: string }> = {};
  for (const i of JSON.parse(gh('issue', 'list', '-R', repo, '--state', 'all', '--limit', '500', '--json', 'number,body,url')) as { number: number; body?: string; url: string }[]) {
    const k = MARK.exec(i.body || '')?.[1];
    if (k && !found[k]) found[k] = { id: String(i.number), url: i.url };
  }
  const ids: Record<string, string> = {}, titles = Object.fromEntries(items.map((it) => [it.key, it.title]));
  return items.map((it) => {
    const have = existing[it.key] || found[it.key];
    if (have) { ids[it.key] = have.id; return { key: it.key, id: have.id, url: have.url, created: false }; }
    const tag = it.kind === 'epic' ? 'factory:epic' : ready ? 'factory:ready' : null;
    const url = gh('issue', 'create', '-R', repo, '--title', it.title, '--body', render(it, ids, titles), ...(tag ? ['--label', tag] : [])).trim();
    const n = /\/issues\/(\d+)$/.exec(url)?.[1];
    if (!n) throw new Error(`gh issue create printed no issue URL: ${url.slice(0, 200)}`);
    ids[it.key] = n;
    const r = { key: it.key, id: n, url, created: true };
    onCreated(r);
    return r;
  });
}

export function listOpen({ gh }: Ctx, { repo }: { repo: string }): OpenIssue[] {
  return (JSON.parse(gh('issue', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--json', 'number,title,labels,body')) as { number: number; title: string; labels?: { name: string }[]; body?: string }[])
    .map((i) => ({ id: String(i.number), title: i.title, labels: (i.labels || []).map((l) => l.name), key: MARK.exec(i.body || '')?.[1] || null, body: i.body || '' }));
}

// Every factory label, so a later add or a PR's --label never meets a missing one.
export function ensureLabels({ gh }: Ctx, { repo }: { repo: string }) {
  const all: [string, string][] = [...STAGES.map((l) => [l, 'BFD4F2'] as [string, string]), ...LABELS];
  for (const [name, color] of all) gh('label', 'create', name, '-R', repo, '--force', '--color', color);
  return all.map(([name]) => name);
}
// Through the REST labels endpoint, with JSON on stdin to add (a Windows gh.cmd shim can't pass labels[] brackets).
// A remove of a label the issue doesn't have is fine; every other failure (a wrong number, no access) throws.
export function label({ gh, ghInput }: Ctx, { repo, id, add = [], remove = [] }: { repo: string; id: string; add?: string[]; remove?: string[] }) {
  if (!ghInput) throw new Error('github-issues label needs ctx.ghInput (gh with stdin)');
  if (add.length) ghInput(JSON.stringify({ labels: add }), 'api', '-X', 'POST', `repos/${repo}/issues/${id}/labels`, '--input', '-');
  for (const l of remove) {
    try { gh('api', '-X', 'DELETE', `repos/${repo}/issues/${id}/labels/${l}`); }
    catch (e) { if (!/Label does not exist/.test(`${(e as { stderr?: unknown }).stderr}${(e as { stdout?: unknown }).stdout}`)) throw e; }
  }
  return { labelled: true };
}
export function comment({ ghInput }: Ctx, { repo, id, body }: { repo: string; id: string; body: string }) {
  if (!ghInput) throw new Error('github-issues comment needs ctx.ghInput (gh with stdin)');
  ghInput(JSON.stringify({ body }), 'api', '-X', 'POST', `repos/${repo}/issues/${id}/comments`, '--input', '-');
  return { posted: true };
}

// "Depends on #3, #5" lines in the body. Ordering only: trust still comes from the issue's author.
export const dependencies = (item: OpenIssue) => [...new Set([...String(item.body || '').matchAll(/^depends on\b(.*)$/gim)].flatMap((m) => [...m[1]!.matchAll(/#(\d+)/g)].map((x) => x[1]!)))]; // group 1 always matches

// The issue itself, so title, author and association are never model-typed. GitHub serves pull requests here too.
// A deleted account's user is null: its author is '', never a name that could match the reporter's.
export function getItem({ gh }: Ctx, { repo, id }: { repo: string; id: string }): TrackerItem {
  const i: { pull_request?: unknown; state: string; title: string; html_url: string; user: { login: string } | null; author_association: string; body?: string | null } = JSON.parse(gh('api', `repos/${repo}/issues/${id}`));
  return { id, title: i.title, url: i.html_url, author: i.user?.login ?? '', association: i.author_association, state: i.state, isChangeRequest: !!i.pull_request, body: i.body };
}
export const comments = ({ gh }: Ctx, { repo, id }: { repo: string; id: string }): Comment[] =>
  (gh('api', '--paginate', `repos/${repo}/issues/${id}/comments`, '--jq', '.[]').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as { user: { login: string } | null; author_association: string; created_at: string; body?: string | null }[])
    .map((c) => ({ author: c.user?.login ?? '', association: c.author_association, created_at: c.created_at, body: c.body }));
export const trust = ({ gh }: Ctx, { repo, id }: { repo: string; id: string }) => gh('api', `repos/${repo}/issues/${id}`, '--jq', '.author_association').trim();
