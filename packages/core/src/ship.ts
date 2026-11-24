import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { read, record } from './log.ts';
import { derive } from './derive.ts';
import type { Deploy, Run } from './types.ts';

// packages/ship, when it sits next to the factory (the repo layout). Optional: without it F works, and deploy.preview=required escalates.
const SHIP_FILE = path.join(import.meta.dirname, '..', '..', 'ship', 'ship.mjs');
// Set by the CLI: mod through loadShip() (sync, merge, ship, onboard, ui…); list is packages/ship's own connector registry
// (onboard, ui). Never a hardcoded provider list. An object, not two lets, because the CLI assigns it from another module.
// What F uses of packages/ship/ship.mjs, loaded at run time: typed here, at the boundary.
type ShipPair = { run: string; repo: string; sha?: string; path?: string };
type ShipResult = { recorded: Deploy[]; errors?: { error: string }[] };
export interface ShipModule {
  ready(): Promise<{ connectors: { id: string; kind: string; label?: string }[] }>;
  track(pairs: ShipPair[], ctx: { runs: Record<string, Run>; record: typeof record }): ShipResult;
  main(argv: string[], opts: { path?: string }): Promise<unknown>;
}
export const ship: { mod: ShipModule | null; list: { id: string; kind: string; label: string }[] | null } = { mod: null, list: null };
export async function loadShip(): Promise<ShipModule | null> {
  const file = SHIP_FILE;
  if (!fs.existsSync(file)) return null;
  try { const m: ShipModule = await import(pathToFileURL(file).href); await m.ready(); return m; } catch (e) { console.error(`factory: ship harness failed to load: ${(e as Error).message}`); return null; }
}
// mod plus its connector list, for onboard and ui (F ui and the desktop app). Loads once.
export async function loadShipList() {
  ship.mod ??= await loadShip();
  try { if (ship.mod) ship.list = (await ship.mod.ready()).connectors.map((c) => ({ id: c.id, kind: c.kind, label: c.label || c.id })); }
  catch (e) { ship.list = null; console.error(`factory: ship connectors failed to load: ${(e as Error).message}`); } // as loadShip: F ui and the app still start
}
// Records deploy state through record(). A failed lookup is reported in the result, never thrown: it must not break sync or merge.
export function shipTrack(pairs: ShipPair[]): ShipResult | undefined {
  if (!ship.mod || !pairs.length) return undefined;
  try { return ship.mod.track(pairs, { runs: derive(read()), record }); } catch (e) { return { recorded: [], errors: [{ error: (e as Error).message }] }; }
}

// Hooks for parallel work: "Create from an idea" is on now that idea-to-app has landed; the ship step lists
// packages/ship's connectors once that package exists.
export const hooks = () => ({ create: true, ship: fs.existsSync(SHIP_FILE) });
export const shipConnectors = () => ship.list;
