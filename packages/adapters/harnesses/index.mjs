// AI harness registry: every <id>.mjs (or <id>.ts) file in this folder is one harness, loaded in file-name order.
// Files starting with "_" (the template), this file and declaration files are skipped (../registry.mjs pluginFiles()).
// HARNESSES.md is the recipe for adding one.
// The core reaches harnesses only through `harnesses`; it never names one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPlugin, pluginFiles, stem } from '../registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[a-z][a-z0-9-]{0,30}$/;
// models(): the aliases a runner on this harness may pick (per-step model, effort and fallback); efforts: its effort levels.
// sessionOf(event) and exitOf(lastEvent): a launchable harness's session id and clean exit (0, else null) in its headless output.
// desktop(): its desktop app, {installed, path?}, found on disk (never launched).
const OPTIONAL = ['desktop', 'headless', 'providerTools', 'sessions', 'notes', 'current', 'headlessArgs', 'models', 'launch', 'sessionOf', 'exitOf'];

// Shape check at load time; behaviour is checked by the shared contract test in factory.mjs.
export function check(h, file) {
  const at = `harnesses/${file}`;
  if (!h || typeof h !== 'object') throw new Error(`${at}: must \`export default\` an adapter object`);
  if (!ID.test(h.id || '') || h.id !== stem(file)) throw new Error(`${at}: id must be lowercase and equal the file name`);
  for (const k of ['label', 'install']) if (typeof h[k] !== 'string' || !h[k].trim()) throw new Error(`${at}: ${k} must be a non-empty string`);
  for (const k of ['detect', 'login']) if (typeof h[k] !== 'function') throw new Error(`${at}: ${k}() is required`);
  for (const k of OPTIONAL) if (h[k] !== undefined && typeof h[k] !== 'function') throw new Error(`${at}: ${k} must be a function`);
  if (h.efforts !== undefined && !(Array.isArray(h.efforts) && h.efforts.every((e) => /^[a-z]+$/.test(e)))) throw new Error(`${at}: efforts must be lowercase level names`);
  if (h.configDirs !== undefined && !(Array.isArray(h.configDirs) && h.configDirs.every((d) => /^\.[\w.-]+$/.test(d)))) throw new Error(`${at}: configDirs must be dot-folder names like ".claude"`);
  return h;
}

export async function load(dir = HERE) {
  const out = [];
  for (const f of pluginFiles(dir)) out.push(check((await importPlugin(dir, f, `harnesses/${f}`)).default, f));
  return out;
}

// FACTORY_HARNESSES is overridable only so the self-test can prove a new harness needs no core change.
export const harnesses = await load(process.env.FACTORY_HARNESSES || HERE);
