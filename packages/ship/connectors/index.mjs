// The registry: every connectors/*.mjs except index.mjs and files starting with "_" is a provider. Adding one is adding a file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConnector } from '../contract.mjs';

export const BUILTIN = path.dirname(fileURLToPath(import.meta.url));

// A file that fails to load or breaks the contract is skipped with a warning: one bad provider never takes the others down.
export async function load(dirs = [BUILTIN]) {
  const connectors = [], warnings = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'index.mjs').sort(); } catch (e) { warnings.push(`${dir}: ${e.message}`); }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const c = (await import(pathToFileURL(file).href)).default;
        const bad = validateConnector(c);
        if (bad.length) { warnings.push(`${f}: ${bad.join('; ')}`); continue; }
        if (connectors.some((x) => x.id === c.id)) { warnings.push(`${f}: duplicate id "${c.id}"`); continue; }
        connectors.push({ ...c, file });
      } catch (e) { warnings.push(`${f}: ${e.message}`); }
    }
  }
  return { connectors, warnings };
}
