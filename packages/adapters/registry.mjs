// Provider registries: one file per provider in a folder, loaded by name. A provider is <id>.mjs, or <id>.ts where Node strips
// types (not under node_modules, not in a "type": "commonjs" package). index.mjs, index.ts, _* files (templates, notes) and
// declaration files (*.d.ts, *.d.mts) are skipped. The id is the file name without its extension, so a.mjs and a.ts in one
// folder (a compiled twin) are one provider twice: refused, never one silently winning.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const stem = (f) => path.basename(f, path.extname(f));
const PLUGIN = /\.(?:mjs|ts)$/, DECLARATION = /\.d\.m?ts$/;
export const isPlugin = (f) => PLUGIN.test(f) && !DECLARATION.test(f) && !f.startsWith('_') && f !== 'index.mjs' && f !== 'index.ts';

// The provider files in dir, sorted by file name (as before .ts: an .mjs-only folder loads in the same order).
export function pluginFiles(dir) {
  const files = fs.readdirSync(dir).filter(isPlugin).sort(), seen = new Map();
  for (const f of files) {
    const twin = seen.get(stem(f));
    if (twin) throw new Error(`${dir}: ${twin} and ${f} are both provider "${stem(f)}": remove one (a .ts and its compiled .mjs can't sit side by side)`);
    seen.set(stem(f), f);
  }
  return files;
}

// Imports one provider file. A .ts file needs a Node that strips types (process.features.typescript): without one it is
// refused up front, naming the file. Any import failure is rethrown naming the file, as `label: <Node's message>`.
export async function importPlugin(dir, f, label = f, typescript = process.features.typescript) {
  if (f.endsWith('.ts') && !typescript) throw new Error(`${label}: this Node doesn't strip TypeScript types (process.features.typescript is off): use ${stem(f)}.mjs`);
  try { return await import(pathToFileURL(path.join(dir, f)).href); }
  catch (e) { throw Object.assign(new Error(`${label}: ${e.message}`, { cause: e }), { code: e.code }); } // e.code: ERR_MODULE_NOT_FOUND, ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, …
}

export async function loadDir(dir, required) {
  const out = {};
  for (const f of pluginFiles(dir)) {
    const m = await importPlugin(dir, f);
    const missing = required.filter((k) => typeof m[k] !== 'function');
    if (m.id !== stem(f)) throw new Error(`${f}: must export id = "${stem(f)}"`);
    if (missing.length) throw new Error(`${f}: missing ${missing.join(', ')}`);
    out[m.id] = m;
  }
  return out;
}
