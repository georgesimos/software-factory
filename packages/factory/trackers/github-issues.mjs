// GitHub Issues tracker, through the logged-in `gh`. Each issue body ends with a hidden key marker, so a re-run
// (even without the local key map) finds what an interrupted run already created instead of creating it twice.
export const id = 'github-issues';

const MARK = /<!-- factory-key: ([a-z0-9][a-z0-9-]*) -->/;
const LABELS = [['factory:ready', 'BFD4F2'], ['factory:epic', 'D4C5F9']];

export function render(it, ids, titles) {
  const ref = (k) => { if (!ids[k]) throw new Error(`"${it.key}" refers to "${k}", which has no issue yet`); return `#${ids[k]}`; };
  const parts = [String(it.body || '').trim()];
  if (it.kind === 'epic') parts.push('## Issues\n' + (it.children || []).map((k) => `- [ ] ${ref(k)} ${titles[k]}`).join('\n'));
  else {
    parts.push('## Acceptance criteria\n' + (it.acceptance || []).map((a) => `- [ ] ${a}`).join('\n'));
    const meta = [it.dependsOn?.length ? `Depends on ${it.dependsOn.map(ref).join(', ')}` : '', it.milestone ? `Milestone: ${it.milestone}` : ''].filter(Boolean);
    if (meta.length) parts.push(meta.join('\n'));
  }
  return [...parts.filter(Boolean), `<!-- factory-key: ${it.key} -->`].join('\n\n');
}

export function createIssues({ gh }, { repo, items, existing = {}, onCreated = () => {} }) {
  for (const [name, color] of LABELS) gh('label', 'create', name, '-R', repo, '--force', '--color', color);
  const found = {};
  for (const i of JSON.parse(gh('issue', 'list', '-R', repo, '--state', 'all', '--limit', '500', '--json', 'number,body,url'))) {
    const k = MARK.exec(i.body || '')?.[1];
    if (k && !found[k]) found[k] = { id: String(i.number), url: i.url };
  }
  const ids = {}, titles = Object.fromEntries(items.map((it) => [it.key, it.title]));
  return items.map((it) => {
    const have = existing[it.key] || found[it.key];
    if (have) { ids[it.key] = have.id; return { key: it.key, id: have.id, url: have.url, created: false }; }
    const url = gh('issue', 'create', '-R', repo, '--title', it.title, '--body', render(it, ids, titles), '--label', it.kind === 'epic' ? 'factory:epic' : 'factory:ready').trim();
    const n = /\/issues\/(\d+)$/.exec(url)?.[1];
    if (!n) throw new Error(`gh issue create printed no issue URL: ${url.slice(0, 200)}`);
    ids[it.key] = n;
    const r = { key: it.key, id: n, url, created: true };
    onCreated(r);
    return r;
  });
}

export function listOpen({ gh }, { repo }) {
  return JSON.parse(gh('issue', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--json', 'number,title,labels,body'))
    .map((i) => ({ id: String(i.number), title: i.title, labels: (i.labels || []).map((l) => l.name), key: MARK.exec(i.body || '')?.[1] || null, body: i.body || '' }));
}

// "Depends on #3, #5" lines in the body. Ordering only: trust still comes from the issue's author.
export const dependencies = (item) => [...new Set([...String(item.body || '').matchAll(/^depends on\b(.*)$/gim)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => x[1])))];
