#!/usr/bin/env node
// Ship harness: reads deploy, build, store and database state through pluggable connectors (connectors/*.mjs).
// `connectors`, `detect` and `status` only read. Recording is track(), which F sync / F postmerge / F decide call with
// factory.mjs's own record(), so factory.mjs stays the only writer. This file imports nothing from the factory.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from './connectors/index.mjs';
import { normalizeRows, statusOf, isDone } from './contract.mjs';

const REPO = /^[\w.-]+\/[\w.-]+$/, SHA = /^[0-9a-f]{7,40}$/;

// What connectors get as ctx.exec. FACTORY_<CMD> swaps the binary (FACTORY_GH, as in factory.mjs) so tests can stub a provider CLI.
export const exec = (cmd, args) => execFileSync(process.env[`FACTORY_${cmd.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || cmd, args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

let loaded = null, current = [];
export async function ready(dirs) { // loads the registry once; track() then uses it
  if (!loaded || dirs) loaded = load(dirs);
  const x = await loaded;
  current = x.connectors;
  return x;
}

const why = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0].slice(0, 300);

// Every connector that detects the project, normalized. A connector that throws becomes an error entry; it never throws here.
export function lookup(connectors, project, sha, ctx = { exec }) {
  const rows = [], errors = [];
  for (const c of connectors) {
    try {
      const k = `${c.id}|${project.repo}`, seen = ctx.detected?.get(k);
      const uses = seen ?? !!c.detect(project, ctx);
      ctx.detected?.set(k, uses);
      if (uses) rows.push(...normalizeRows(c, c.status(project, sha, ctx)).filter((r) => !sha || r.sha === sha));
    } catch (e) { errors.push({ connector: c.id, error: why(e) }); }
  }
  return { rows, errors };
}

// Records new states for [{run, repo, sha, path?}] through the given record(). Skips a commit whose recorded states are all final
// (cached per sha), and a state already recorded for the same connector, env and commit.
// shortcut: "all final" can hide a second provider that deploys the same commit later; drop the skip if that ever matters.
export function track(pairs, { runs, record, connectors = current, exec: ex = exec }) {
  const out = { recorded: [], errors: [] }, memo = new Map(), ctx = { exec: ex, detected: new Map() };
  for (const { run, repo, sha, path } of pairs) {
    const r = runs[run];
    if (!r || !REPO.test(repo || '') || !SHA.test(sha || '')) continue;
    const mine = (r.deploys || []).filter((d) => d.sha === sha);
    if (mine.length && mine.every((d) => isDone(d.kind, d.state))) continue;
    const key = `${repo}@${sha}`;
    if (!memo.has(key)) {
      memo.set(key, lookup(connectors, { repo, path }, sha, ctx));
      out.errors.push(...memo.get(key).errors.map((e) => ({ repo, sha, ...e })));
    }
    for (const row of memo.get(key).rows) {
      const prev = (r.deploys || []).find((d) => d.connector === row.connector && d.env === row.env);
      if (prev && prev.sha === row.sha && prev.state === row.state) continue;
      record(run, 'ship', statusOf(row.kind, row.state), row);
      out.recorded.push({ run, ...row });
    }
  }
  return out;
}

const USAGE = `usage: ship.mjs <command>
  connectors                       registered connectors, their kind and tagged actions
  detect <owner/repo> [--path dir]  which connectors this project uses, and whether each one's CLI is logged in
  status <owner/repo> [sha] [--path dir]  normalized state per connector and env (read only)`;

export async function main(argv, opts = {}) {
  const args = [...argv], i = args.indexOf('--path'), path = i < 0 ? opts.path : args.splice(i, 2)[1];
  const [cmd, repo, sha] = args;
  const { connectors, warnings } = await ready();
  for (const w of warnings) console.error(`ship: skipped connector ${w}`);
  if (cmd === 'connectors') return connectors.map((c) => ({ id: c.id, kind: c.kind, actions: Object.fromEntries(Object.entries(c.actions).map(([k, a]) => [k, a.tag])) }));
  if (!['detect', 'status'].includes(cmd) || !REPO.test(repo || '') || (sha !== undefined && !SHA.test(sha))) throw new Error(USAGE);
  const project = { repo, path }, ctx = { exec };
  if (cmd === 'detect') return connectors.map((c) => {
    try { return { connector: c.id, kind: c.kind, detected: !!c.detect(project, ctx), auth: c.auth(ctx) }; } catch (e) { return { connector: c.id, kind: c.kind, error: why(e) }; }
  });
  return { repo, ...(sha && { sha }), ...lookup(connectors, project, sha, ctx) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((x) => console.log(JSON.stringify(x, null, 2)), (e) => { console.error(e.message.startsWith('usage') ? e.message : `ship: ${e.message}`); process.exitCode = 1; });
}
