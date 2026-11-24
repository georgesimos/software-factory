// Types for sessions.mjs, for the typed server.
import type { Harness, LaunchSpec } from './harnesses/index.d.mts';
import type { Command, Resolve } from '../core/src/platform.ts';

/** One event of a session: n is its position (absent on 'dropped'), the rest is what the harness or the runner emitted. */
export interface SessionEvent { n?: number; at?: string; type: string; [k: string]: unknown }
/** exit: 0 or a code, a signal name, 'stopped', or null while running. */
export interface Session {
  id: string; harness: string; mode: string; label: string; cwd?: string;
  state: string; exit: number | string | null; started: string; ended: string | null; harnessSession?: string;
  events: SessionEvent[];
  stop(wait?: boolean): void;
  write?(data: string): void; // terminal sessions
  resize?(cols: number, rows: number): void;
}
export type SessionInfo = Pick<Session, 'id' | 'harness' | 'mode' | 'label' | 'state' | 'exit' | 'started' | 'ended' | 'harnessSession'>;
export const MAX_BYTES: number;
export function getSession(id: string): Session | undefined;
export function listSessions(): SessionInfo[];
export function subscribe(s: Session, fn: (e: SessionEvent) => void, from?: number): () => void;
export function resolveSpec(spec: LaunchSpec, env: NodeJS.ProcessEnv, resolve?: Resolve): Command;
export function killTree(child: { pid?: number; kill(): unknown }, platform?: NodeJS.Platform, run?: unknown, kill?: unknown, wait?: boolean): void;
export const stopAll: () => void;
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function startSession(h: Harness, opts: { mode: string; prompt?: string; resume?: string; budget?: number; write?: boolean },
  ctx: { cwd?: string; env?: NodeJS.ProcessEnv; label?: string; modules?: Record<string, unknown>; resolve?: Resolve; onPid?: (pid: number) => void }): Session;
export function codexBinary(env: NodeJS.ProcessEnv, resolve?: Resolve): string | undefined;
