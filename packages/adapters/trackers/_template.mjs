// Copy to trackers/<id>.mjs (the file name is the id), fill in the three functions, and run `node factory.mjs test`:
// the shared contract in trackers/index.mjs runs against every file here. No core change is needed. See README.md.
export const id = '_template';

// items arrive in dependency order: [{key, title, body, acceptance[], dependsOn[keys], milestone}, …, {key:"epic", kind:"epic", title, body, children[keys]}].
// Skip any key in `existing` ({key: {id, url}}) or already in the tracker; call onCreated({key, id, url, created:true}) right after each
// create; label every non-epic issue factory:ready. -> [{key, id, url, created}] in the same order. ids are strings.
export function createIssues(ctx, { repo, items, existing, onCreated }) { throw new Error('not implemented'); }

// -> [{id, title, labels: [names], key|null, …anything dependencies() needs}] for the project's open issues.
export function listOpen(ctx, { repo }) { throw new Error('not implemented'); }

// One item from listOpen -> the ids it depends on.
export function dependencies(item) { throw new Error('not implemented'); }
