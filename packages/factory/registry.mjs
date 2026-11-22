// Provider registries: one file per provider in a folder, loaded by name. index.mjs and _* files (templates, notes) are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadDir(dir, required) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs' && !f.startsWith('_')).sort()) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    const missing = required.filter((k) => typeof m[k] !== 'function');
    if (m.id !== f.slice(0, -4)) throw new Error(`${f}: must export id = "${f.slice(0, -4)}"`);
    if (missing.length) throw new Error(`${f}: missing ${missing.join(', ')}`);
    out[m.id] = m;
  }
  return out;
}
