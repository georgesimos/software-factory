/** localStorage that never throws (private windows, blocked storage). `null` clears the key. */
export function store(k: string, v?: string | null): string | null {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch { /* the view just won't be remembered */ }
  return null;
}
