// AI harness registry: every <id>.mjs (or <id>.ts) file in this folder is one harness, loaded in file-name order.
// Files starting with "_" (the template), this file and declaration files are skipped (../registry.ts pluginFiles()).
// HARNESSES.md is the recipe for adding one.
// The core reaches harnesses only through `harnesses`; it never names one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPlugin, pluginFiles, stem } from '../registry.ts';

// HARNESSES.md is the contract; check() enforces its shape at load time.
/** models(): what HARNESSES.md documents. minVersion: an older CLI falls down the step's fallback chain. */
export interface HarnessModel { id: string; alias: string; label: string; minVersion?: string }
/** providerTools(): an entry of the runner picker; tool, when set, becomes the runner's name. */
export interface ProviderTool { name: string; desc: string; tool?: string }
/** What launch() describes: a command (headless, terminal, app-server), or for sdk mode a module and its options; sessions.ts runs it. */
export interface LaunchSpec {
  cmd?: string; args?: string[]; stdin?: string; rpc?: { prompt: string; thread: { threadId?: string; [k: string]: unknown } };
  module?: string; prompt?: string; resume?: string; options?: { stderr?: (data: string) => void; [k: string]: unknown }; thread?: object; offRun?: string;
}
export interface Harness {
  id: string;
  label: string;
  install: string;
  detect(): { installed?: boolean; version?: string | null };
  login(): { ok: boolean; hint: string };
  /** Its desktop app on this machine, found on disk. at: where to look (tests). */
  desktop?(at?: { platform?: string; home?: string; env?: Record<string, string | undefined>; root?: string }): { installed: boolean; path?: string };
  configDirs?: string[];
  efforts?: string[];
  modes?: string[];
  host?: boolean;
  current?(): string | null;
  sessions?(repoPath: string, remote: string): { branch?: string; id?: string; cwd?: string; last: string }[];
  notes?(): { label: string; ok: boolean | null; hint: string }[];
  headless?(): unknown;
  headlessArgs?(opts?: object): string[];
  providerTools?(): ProviderTool[];
  models?(): HarnessModel[];
  launch?(opts: { mode: string; prompt?: string; resume?: string; budget?: number; write?: boolean }): LaunchSpec;
  openDesktop?(id: string): string | null;
  sessionOf?(event: unknown): string | undefined;
  exitOf?(event: unknown): 0 | null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[a-z][a-z0-9-]{0,30}$/;
// models(): the aliases a runner on this harness may pick (per-step model, effort and fallback); efforts: its effort levels.
// sessionOf(event) and exitOf(lastEvent): a launchable harness's session id and clean exit (0, else null) in its headless output.
// desktop(): its desktop app, {installed, path?}, found on disk (never launched).
const OPTIONAL = ['desktop', 'headless', 'providerTools', 'sessions', 'notes', 'current', 'headlessArgs', 'models', 'launch', 'sessionOf', 'exitOf'];

// Shape check at load time; behaviour is checked by the shared contract test in factory.mjs.
export function check(h: any, file: string): Harness { // h: any module's default export, checked here
  const at = `harnesses/${file}`;
  if (!h || typeof h !== 'object') throw new Error(`${at}: must \`export default\` an adapter object`);
  if (!ID.test(h.id || '') || h.id !== stem(file)) throw new Error(`${at}: id must be lowercase and equal the file name`);
  for (const k of ['label', 'install']) if (typeof h[k] !== 'string' || !h[k].trim()) throw new Error(`${at}: ${k} must be a non-empty string`);
  for (const k of ['detect', 'login']) if (typeof h[k] !== 'function') throw new Error(`${at}: ${k}() is required`);
  for (const k of OPTIONAL) if (h[k] !== undefined && typeof h[k] !== 'function') throw new Error(`${at}: ${k} must be a function`);
  if (h.efforts !== undefined && !(Array.isArray(h.efforts) && h.efforts.every((e: string) => /^[a-z]+$/.test(e)))) throw new Error(`${at}: efforts must be lowercase level names`);
  if (h.configDirs !== undefined && !(Array.isArray(h.configDirs) && h.configDirs.every((d: string) => /^\.[\w.-]+$/.test(d)))) throw new Error(`${at}: configDirs must be dot-folder names like ".claude"`);
  return h;
}

export async function load(dir = HERE): Promise<Harness[]> {
  const out: Harness[] = [];
  for (const f of pluginFiles(dir)) out.push(check((await importPlugin(dir, f, `harnesses/${f}`)).default, f));
  return out;
}

// FACTORY_HARNESSES is overridable only so the self-test can prove a new harness needs no core change.
export const harnesses = await load(process.env.FACTORY_HARNESSES || HERE);
