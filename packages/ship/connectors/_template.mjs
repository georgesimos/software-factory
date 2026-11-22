// Template for a new provider. Copy to connectors/<id>.mjs (no leading "_"), fill it in, and add test/fixtures/<id>.json.
// The registry picks it up by itself; nothing else in the repo changes. See CONNECTORS.md and contract.mjs.
// Import nothing from the factory: a connector only reads its provider, through ctx.exec, and returns plain rows.

export default {
  id: 'my-host', // lowercase, unique; shown in events and the dashboard
  kind: 'web-deploy', // web-deploy | mobile-build | store | database (contract.mjs KINDS lists each kind's states)

  // Cheap check that the project uses this provider: a config file in project.path, or one read call.
  detect(project, ctx) {
    return false; // e.g. fs.existsSync(path.join(project.path || '', 'my-host.json'))
  },

  // Is the provider's own CLI logged in? Never read, store or print a token.
  auth(ctx) {
    try { ctx.exec('my-host', ['whoami']); return { ok: true, how: 'my-host login' }; } catch { return { ok: false, how: 'my-host login' }; }
  },

  // Normalized rows. With sha: what was built from that commit. Without: the latest per environment.
  // env: "preview" and "production" are the names the factory's rules look for; anything else is shown as-is.
  status(project, sha, ctx) {
    const list = JSON.parse(ctx.exec('my-host', ['ls', '--json', ...(sha ? ['--sha', sha] : [])]));
    return list.map((d) => ({ env: d.target === 'production' ? 'production' : 'preview', state: { READY: 'ready', ERROR: 'error', BUILDING: 'building' }[d.state] || 'queued',
      url: d.url, sha: d.sha, at: d.createdAt, detail: d.message, creator: d.creator }));
  },

  // Every action is tagged: read (safe), write (changes provider state), public (users can see it: a production deploy, a store release).
  // Phase 0 ships no write or public actions.
  actions: {},
};
