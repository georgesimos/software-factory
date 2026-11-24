// Types for index.mjs, for the typed core. The registry loads only *.mjs, so this file is never loaded as a tracker.
// README.md is the contract; loadDir() checks the required functions at load time.
import type { Ctx } from '../hosts/index.d.mts';
export interface Item {
  key: string; title: string; body: string; kind?: string; children?: string[];
  acceptance?: string[]; dependsOn?: string[]; milestone?: string; files?: string[];
}
export interface Created { key: string; id: string; url?: string; created: boolean }
export interface OpenIssue { id: string; title: string; labels: string[]; key?: string }
export interface Tracker {
  id: string;
  createIssues(ctx: Ctx, opts: { repo: string; items: Item[]; existing: Record<string, { id: string; url?: string | undefined }>; onCreated: (r: Created) => void }): Created[];
  listOpen(ctx: Ctx, opts: { repo: string }): OpenIssue[];
  dependencies(item: OpenIssue): string[];
}
export const REQUIRED: string[];
export function load(dir?: string): Promise<Record<string, Tracker>>;
export function contract(p: Tracker, opts: { ctx: Ctx; repo: string }): void;
