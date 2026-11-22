import { useId, useState } from 'react';
import { cx } from './cx.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_STORAGE_KEY = 'sf.theme';

/**
 * Inline this in <head> before any stylesheet so the stored theme applies before first paint (no flash).
 * With a strict CSP, allow it by hash.
 */
export const themeInitScript = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

/** The current choice: an explicit data-theme on <html> wins, then storage, then "system". */
export function readTheme(): ThemeChoice {
  const d = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  if (d === 'light' || d === 'dark') return d;
  try {
    const s = localStorage.getItem(THEME_STORAGE_KEY);
    if (s === 'light' || s === 'dark' || s === 'system') return s;
  } catch { /* storage blocked: fall through */ }
  return 'system';
}

/** Sets data-theme on <html> ("system" removes it so prefers-color-scheme applies) and remembers the choice. */
export function applyTheme(t: ThemeChoice) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch { /* private mode: the choice lasts this page only */ }
}

const OPTIONS: [ThemeChoice, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

/** Light / dark / system as a radio group: arrow keys move, the platform handles focus. */
export function ThemeToggle({ onChange, className }: { onChange?: (t: ThemeChoice) => void; className?: string }) {
  const [value, setValue] = useState<ThemeChoice>(readTheme);
  const name = useId();
  return (
    <div role="radiogroup" aria-label="Theme" className={cx('sf-theme-toggle', className)}>
      {OPTIONS.map(([v, label]) => (
        <label key={v} className="sf-theme-opt">
          <input type="radio" name={name} value={v} checked={value === v} className="sf-sr-only"
            onChange={() => { applyTheme(v); setValue(v); onChange?.(v); }} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}
