// GitHub Deployments: the zero-credential baseline. Vercel, Netlify, Render and GitHub Actions post a deployment plus statuses for
// each build, so `gh` (already logged in for the factory) reads preview and production state without a provider login.
const api = (ctx, p) => JSON.parse(ctx.exec('gh', ['api', p]));

// GitHub's status states -> web-deploy states. "inactive" is what GitHub sets on an older deployment once a newer one in the same
// environment succeeds. With only the latest status read, that can't be told from a manual deactivation, so it is not "ready":
// the deploy.preview gate errs strict. shortcut: never seen in real data yet; read the status history if previews get stuck on it.
function stateOf(s) {
  if (!s) return 'queued';
  if (s.state === 'success') return 'ready';
  if (s.state === 'inactive') return 'canceled';
  if (s.state === 'in_progress') return 'building';
  if (s.state === 'error' && /deleted/i.test(s.description || '')) return 'canceled'; // the host pruned it: not a build failure
  if (s.state === 'error' || s.state === 'failure') return 'error';
  return 'queued'; // queued, pending
}

// Vercel names them "Preview – <project>" / "Production – <project>" and leaves production_environment false, so names decide too.
// shortcut: two projects on one repo both map to "preview" and share one row (either can meet the gate); key on the raw name if that matters.
const envOf = (d) => d.production_environment || /^production\b/i.test(d.environment) ? 'production'
  : /^preview\b/i.test(d.environment) ? 'preview' : String(d.environment || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default {
  id: 'github-deployments',
  kind: 'web-deploy',
  detect: (project, ctx) => api(ctx, `repos/${project.repo}/deployments?per_page=1`).length > 0,
  auth(ctx) {
    try { ctx.exec('gh', ['auth', 'status']); return { ok: true, how: 'gh auth login' }; } catch { return { ok: false, how: 'gh auth login' }; }
  },
  // With a sha: every environment deployed at that commit. Without: the newest deployment per environment. One status read each.
  status(project, sha, ctx) {
    const list = api(ctx, `repos/${project.repo}/deployments?${sha ? `sha=${sha}&` : ''}per_page=30`);
    const newest = new Map();
    for (const d of list) if (!newest.has(d.environment)) newest.set(d.environment, d); // GitHub lists newest first
    return [...newest.values()].map((d) => {
      const s = api(ctx, `repos/${project.repo}/deployments/${d.id}/statuses?per_page=1`)[0];
      return { env: envOf(d), state: stateOf(s), url: s?.environment_url, sha: d.sha, at: s?.created_at || d.created_at, detail: s?.description || (s?.state === 'inactive' ? 'inactive: a newer deployment replaced it' : undefined), creator: d.creator?.login };
    });
  },
  actions: {},
};
