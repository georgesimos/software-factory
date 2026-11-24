// A clone's origin, in any form git takes (scp-like user@host:path, ssh://, https://, file:// or a plain path), as the
// project id, host and remote F stores in projects.json (docs/plans/local-first.md §1.1). GitHub ids are exactly what they
// were; any other id is sanitized to F's owner/repo shape. Host is decided once, at attach, and never re-read from the id.
import path from 'node:path';

// user@host:path (no scheme, no drive letter) or scheme://[user[:pass]@]host[:port]/path. A plain or file:// path has no host.
const SCP = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/, URLISH = /^[a-z][\w+.-]*:\/\/(?:[^@/\s]*@)?([^/:\s]*)(?::\d+)?(\/.*)?$/i;
const isDrive = (u: string) => /^[A-Za-z]:[\\/]/.test(u);

/** {host, path} of a network remote ("github.com", "acme/shop"), or null for a local path, file:// or nothing. */
export function remoteParts(url: string | undefined | null): { host: string; path: string } | null {
  const u = String(url || '').trim();
  if (!u || isDrive(u) || /^file:/i.test(u)) return null;
  const m = URLISH.exec(u) || SCP.exec(u);
  if (!m || !m[1]) return null;
  const p = String(m[2] || '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return p ? { host: m[1].toLowerCase(), path: p } : null;
}
/** One form for "the same repo": ssh, scp and https of it are equal ("github.com/acme/shop"); null for a local origin. */
export const normRemote = (url: string | undefined | null) => { const r = remoteParts(url); return r ? `${r.host}/${r.path.toLowerCase()}` : null; };
/** The URL without credentials, the only form F stores: http(s) loses its whole user[:token]@ (a token is often the user
 *  part), any other scheme its :password (ssh://git@host keeps the login it needs). */
export const withoutUserinfo = (url: string) => url.replace(/^(https?:\/\/)[^@/\s]*@/i, '$1').replace(/^([a-z][\w+.-]*:\/\/[^:@/\s]*):[^@/\s]*@/i, '$1@');

const owner = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39) || 'x';
const name = (s: string) => (s.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'x');
/** The project id for a clone: GitHub's owner/name as is; another host's path as owner/name (groups joined by "-"); no network origin: local/<folder>. */
export function cloneId(url: string | undefined | null, dir: string): string {
  const r = remoteParts(url);
  if (!r) return `local/${name(path.basename(path.resolve(dir)))}`;
  const parts = r.path.split('/').filter(Boolean);
  if (r.host === 'github.com' && parts.length === 2 && /^[\w.-]+$/.test(parts.join(''))) return `${parts[0]}/${parts[1]}`;
  return `${owner(parts.slice(0, -1).join('-') || r.host.split('.')[0]!)}/${name(parts.at(-1)!)}`;
}
/** The host a new project gets: github for a github.com origin; git for any other network origin, or for a local/ id with a
 *  local or no origin. Anything else (an owner/repo attached by path, as before) stays github. */
export function hostFor(url: string | undefined | null, id: string): 'github' | 'git' {
  const r = remoteParts(url);
  if (r) return r.host === 'github.com' ? 'github' : 'git';
  return id.startsWith('local/') ? 'git' : 'github';
}
