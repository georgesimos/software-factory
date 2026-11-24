// Types for index.mjs, for the typed core. The registry loads only *.mjs, so this file is never loaded as a harness.
// HARNESSES.md is the contract; check() enforces its shape at load time.
export interface Harness {
  id: string;
  label: string;
  install: string;
  detect(): { installed?: boolean; version?: string | null };
  login(): { ok: boolean; hint: string };
  configDirs?: string[];
  efforts?: string[];
  modes?: string[];
  host?: boolean;
  current?(): string | null;
  sessions?(repoPath: string, remote: string): { branch?: string; id?: string; cwd?: string; last: string }[];
  notes?(): { label: string; ok: boolean | null; hint: string }[];
  headless?(): unknown;
  headlessArgs?(opts?: object): string[];
  providerTools?(): unknown[];
  models?(): unknown[];
  launch?(opts: object): unknown;
  openDesktop?(id: string): string | null;
  sessionOf?(event: unknown): string | undefined;
  exitOf?(event: unknown): 0 | null;
}
export function check(h: unknown, file: string): Harness;
export function load(dir?: string): Promise<Harness[]>;
export const harnesses: Harness[];
