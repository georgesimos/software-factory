// Copy to trackers/<id>.ts (the file name is the id), fill in the three functions, and run `node factory.mjs test`:
// the shared contract in trackers/index.ts runs against every file here. No core change is needed. See README.md.
// For a tracker kept outside this repo, copy it to <id>.mjs instead and delete the type annotations (and the import type lines).
import type { Ctx } from '../hosts/index.ts';
import type { Created, Item, OpenIssue } from './index.ts';

export const id = '_template';

// items arrive in dependency order: [{key, title, body, acceptance[], dependsOn[keys], milestone}, …, {key:"epic", kind:"epic", title, body, children[keys]}].
// Skip any key in `existing` ({key: {id, url}}) or already in the tracker; call onCreated({key, id, url, created:true}) right after each
// create; label every non-epic issue factory:ready, unless ready is false (F split for an untrusted parent: no label at all).
// -> [{key, id, url, created}] in the same order. ids are strings.
export function createIssues(ctx: Ctx, { repo, items, existing, onCreated, ready = true }: { repo: string; items: Item[]; existing?: Record<string, { id: string; url?: string }>; onCreated?: (r: Created) => void; ready?: boolean }): Created[] { throw new Error('not implemented'); }

// -> [{id, title, labels: [names], key|null, …anything dependencies() needs}] for the project's open issues.
export function listOpen(ctx: Ctx, { repo }: { repo: string }): OpenIssue[] { throw new Error('not implemented'); }

// One item from listOpen -> the ids it depends on.
export function dependencies(item: OpenIssue): string[] { throw new Error('not implemented'); }
