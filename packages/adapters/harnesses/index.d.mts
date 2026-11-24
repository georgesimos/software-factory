// Types for index.mjs, for the typed core. The registry loads only *.mjs, so this file is never loaded as a harness.
// HARNESSES.md is the contract; check() enforces its shape at load time.
/** models(): what HARNESSES.md documents. minVersion: an older CLI falls down the step's fallback chain. */
export interface HarnessModel { id: string; alias: string; label: string; minVersion?: string }
/** providerTools(): an entry of the runner picker; tool, when set, becomes the runner's name. */
export interface ProviderTool { name: string; desc: string; tool?: string }
/** What launch() describes: a command (headless, terminal, app-server), or for sdk mode a module and its options; sessions.mjs runs it. */
export interface LaunchSpec {
  cmd?: string; args?: string[]; stdin?: string; rpc?: object;
  module?: string; prompt?: string; resume?: string; options?: object; thread?: object; offRun?: string;
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
export function check(h: unknown, file: string): Harness;
export function load(dir?: string): Promise<Harness[]>;
export const harnesses: Harness[];
