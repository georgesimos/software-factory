// F render's file re-reads itself every 10 s (location.reload). What it keeps across that: the window, board and docked
// panel scroll, and the focused control, matched by href, id, label or text (the React app has no stable keys of its own).
const KEY = 'sf.view', SCROLLERS = ['.web-board-wrap', '.web-panel'];
const key = (e: Element) => `${e.tagName}|${e.getAttribute('href') ?? (e.id || e.getAttribute('aria-label') || e.textContent?.trim() || '')}`;
type View = { x: number; y: number; s: ([number, number] | null)[]; f: string | null };

export function saveView() {
  const a = document.activeElement;
  const v: View = { x: scrollX, y: scrollY, s: SCROLLERS.map((q) => { const e = document.querySelector(q); return e ? [e.scrollLeft, e.scrollTop] : null; }), f: a && a !== document.body ? key(a) : null };
  try { history.scrollRestoration = 'manual'; sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* the reload just starts at the top */ }
}

/** Once, after the first render with data: puts back what saveView() kept, if this load is that reload. */
export function restoreView() {
  let v: View;
  try { v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); sessionStorage.removeItem(KEY); } catch { return; }
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  // Any other shape (an older build's, a hand edit) is dropped: this runs in a mount effect, where a throw blanks the page.
  if (!v || !n(v.x) || !n(v.y) || !Array.isArray(v.s) || !v.s.every((p) => p === null || (Array.isArray(p) && p.length === 2 && p.every(n))) || !(v.f === null || typeof v.f === 'string')) return;
  SCROLLERS.forEach((q, i) => { const e = document.querySelector(q), s = v.s[i]; if (e && s) [e.scrollLeft, e.scrollTop] = s; });
  scrollTo(v.x, v.y);
  if (v.f) [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].find((e) => key(e) === v.f)?.focus({ preventScroll: true });
}
