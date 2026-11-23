import { Button, Kbd, type Run } from '@software-factory/design-system';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { store } from './store.ts';

// The docked run panel on wide screens: drag the separator or use its arrow keys to resize; Focus widens it to most of
// the screen; the width is remembered. The CSS clamp has the final say, so the width is read back from layout.
export const MIN_W = 420, BOARD_MIN = 340;
const clamp = (w: number) => Math.round(Math.max(MIN_W, Math.min(w, document.documentElement.clientWidth - BOARD_MIN)));

export function Panel({ run, onClose, children }: { run: Run | null; onClose: () => void; children: ReactNode }) {
  const [w, setW] = useState(() => Number(store('sf.panelW')) || 0);
  const [focus, setFocusState] = useState(() => store('sf.panelFocus') === '1');
  const setFocus = (f: boolean) => { store('sf.panelFocus', f ? '1' : '0'); setFocusState(f); };
  const aside = useRef<HTMLElement>(null), [now, setNow] = useState(0);
  const width = (x: number, save = true) => { const v = clamp(x); setW(v); if (save) store('sf.panelW', String(v)); if (focus) setFocus(false); return v; }; // a manual width ends focus mode
  useEffect(() => { setNow(Math.round(aside.current?.getBoundingClientRect().width ?? 0)); });
  useEffect(() => { if (run) { aside.current?.scrollTo?.(0, 0); document.getElementById('d-title')?.focus({ preventScroll: true }); } }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sep = e.currentTarget;
    sep.setPointerCapture?.(e.pointerId);
    sep.focus({ preventScroll: true });
    document.body.dataset.dragging = '';
    let last = 0; // saved once, on release
    sep.onpointermove = (ev) => { last = width(document.documentElement.clientWidth - ev.clientX, false); };
    sep.onpointerup = sep.onpointercancel = () => { sep.onpointermove = null; delete document.body.dataset.dragging; if (last) store('sf.panelW', String(last)); };
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 20, cur = aside.current?.getBoundingClientRect().width ?? MIN_W;
    if (e.key === 'ArrowLeft') width(cur + step); else if (e.key === 'ArrowRight') width(cur - step); else return;
    e.preventDefault();
  };
  return (
    <>
      <div className="web-resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-controls="detail" aria-label="Resize run panel"
        aria-valuemin={MIN_W} aria-valuemax={Math.max(MIN_W, document.documentElement.clientWidth - BOARD_MIN)} aria-valuenow={now} onPointerDown={drag} onKeyDown={key} />
      <aside ref={aside} id="detail" className="web-panel" aria-labelledby="d-title" data-focus={(run && focus) || undefined} style={w && !(run && focus) ? { width: w } : undefined}>
        <div className="web-panel-bar">
          <span className="web-panel-id">{run ? run.id : 'Run details'}</span>
          {run ? (
            <span className="web-panel-acts">
              <Button size="sm" variant="ghost" aria-pressed={focus} title="Widen the panel to most of the screen" onClick={() => setFocus(!focus)}>Focus</Button>
              <Button size="sm" variant="ghost" aria-label="Close run details" onClick={onClose}>Close <Kbd aria-hidden>Esc</Kbd></Button>
            </span>
          ) : null}
        </div>
        {children}
      </aside>
    </>
  );
}
