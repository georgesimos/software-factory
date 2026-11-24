// Types for index.mjs, for the typed core. The registry loads only *.mjs, so this file is never loaded as a host.
// README.md is the contract; loadDir() checks the required functions at load time.
export type Ctx = { gh: (...args: string[]) => string; git: (...args: string[]) => string };
export interface Host {
  id: string;
  authStatus(ctx: Ctx): { ok: boolean; login?: string; detail?: string };
  createRepo(ctx: Ctx, opts: { repo: string; visibility: string; description?: string }): { created: boolean; url: string };
  pushInitial(ctx: Ctx, opts: { repo: string; path: string; branch?: string }): { pushed: boolean };
}
export const REQUIRED: string[];
export function load(dir?: string): Promise<Record<string, Host>>;
export function contract(p: Host, opts: { ctx: Ctx; repo: string; clone: string }): void;
