// The connector contract. Every provider file in connectors/ default-exports one object of this shape; nothing in core names a provider.
//
//   id       'my-host': lowercase, unique; it is what events and the dashboard show
//   kind     one of KINDS: what the states below mean
//   detect(project, ctx) -> boolean               does this project use the provider? project = {repo: 'owner/repo', path?: local clone}
//   auth(ctx)            -> {ok, how}             is the provider's own CLI logged in? `how` is the login command. Never stores secrets.
//   status(project, sha, ctx) -> [{env, state, url?, sha?, at?, detail?, creator?}]   sha optional: then the latest per env
//   actions  {name: {tag: 'read'|'write'|'public', run(project, ctx, ...args)}}   phase 0 ships read-only connectors
//
// ctx.exec(cmd, args) runs a CLI and returns its stdout (execFileSync; FACTORY_<CMD> swaps the binary, as FACTORY_GH does in factory.mjs).

// Normalized states per kind. ok/bad: what the factory treats as success or failure; the rest are in flight or neutral (canceled).
export const KINDS = {
  'web-deploy': { states: ['queued', 'building', 'ready', 'error', 'canceled', 'promoted'], ok: ['ready', 'promoted'], bad: ['error'] },
  'mobile-build': { states: ['queued', 'building', 'finished', 'errored'], ok: ['finished'], bad: ['errored'] },
  store: { states: ['processing', 'testflight', 'in-review', 'rejected', 'approved', 'released'], ok: ['testflight', 'approved', 'released'], bad: ['rejected'] },
  database: { states: ['branch-created', 'migrated', 'migration-failed', 'deleted'], ok: ['branch-created', 'migrated'], bad: ['migration-failed'] },
};
export const TAGS = ['read', 'write', 'public'];
const ID = /^[a-z][a-z0-9-]{0,30}$/;

// The factory's event status for a state: passed | failed | started (anything not yet good or bad, canceled included).
export const statusOf = (kind, state) => (KINDS[kind]?.ok.includes(state) ? 'passed' : KINDS[kind]?.bad.includes(state) ? 'failed' : 'started');

export function validateConnector(c) {
  const bad = [];
  if (!c || typeof c !== 'object') return ['must default-export an object'];
  if (!ID.test(c.id || '')) bad.push('id must be lowercase letters, digits and dashes');
  if (!KINDS[c.kind]) bad.push(`kind must be ${Object.keys(KINDS).join('|')}`);
  for (const f of ['detect', 'auth', 'status']) if (typeof c[f] !== 'function') bad.push(`${f} must be a function`);
  if (!c.actions || typeof c.actions !== 'object' || Array.isArray(c.actions)) bad.push('actions must be an object (may be empty)');
  else for (const [k, a] of Object.entries(c.actions)) {
    if (!TAGS.includes(a?.tag)) bad.push(`action ${k} needs tag ${TAGS.join('|')}`);
    if (typeof a?.run !== 'function') bad.push(`action ${k} needs run()`);
  }
  return bad;
}

// Provider output is third-party text: keep only the contract's fields, in bounds. A state outside the kind's list is a connector bug and throws.
const text = (s, n) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined);
export function normalizeRows(c, rows) {
  if (!Array.isArray(rows)) throw new Error(`${c.id}: status() must return an array`);
  return rows.map((r) => {
    if (!KINDS[c.kind].states.includes(r?.state)) throw new Error(`${c.id}: state "${r?.state}" is not a ${c.kind} state (${KINDS[c.kind].states.join('|')})`);
    const env = text(r.env, 40);
    if (!env) throw new Error(`${c.id}: every row needs an env`);
    return {
      connector: c.id, kind: c.kind, env, state: r.state,
      url: /^https:\/\/[^\s"'<>]{1,500}$/.test(r.url || '') ? r.url : undefined, // https or nothing
      sha: /^[0-9a-f]{7,40}$/.test(r.sha || '') ? r.sha : undefined,
      at: !isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : undefined,
      detail: text(r.detail, 200), creator: text(r.creator, 60),
    };
  });
}
