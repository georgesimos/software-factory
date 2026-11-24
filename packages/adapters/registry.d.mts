// Types for registry.mjs, for typed callers (apps/desktop's vite config).
export function stem(f: string): string;
export function isPlugin(f: string): boolean;
export function pluginFiles(dir: string): string[];
export function importPlugin(dir: string, f: string, label?: string, typescript?: unknown): Promise<Record<string, unknown>>;
export function loadDir<T = Record<string, unknown>>(dir: string, required: string[]): Promise<Record<string, T>>;
