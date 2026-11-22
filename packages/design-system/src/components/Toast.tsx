import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tone } from '../tokens.ts';
import { IconButton } from './Button.tsx';
import { Dot } from './Dot.tsx';
import { CloseIcon } from './icons.tsx';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: Tone;
  action?: { label: string; onClick: () => void };
  /** ms before auto-dismiss; 0 keeps it until closed. Paused while hovered or focused. */
  duration?: number;
}
interface Item extends ToastOptions { id: number }

const Ctx = createContext<((t: ToastOptions) => number) | null>(null);

/** Returns `toast(options)`. Must be inside <ToastProvider>. */
export function useToast() {
  const t = useContext(Ctx);
  if (!t) throw new Error('useToast must be used inside <ToastProvider>');
  return t;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const toast = useCallback((t: ToastOptions) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-2), { ...t, id }]); // at most 3 on screen
    return id;
  }, []);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  return (
    <Ctx.Provider value={toast}>
      {children}
      <ol className="sf-toasts" aria-live="polite" aria-label="Notifications">
        {items.map((t) => <ToastItem key={t.id} item={t} onDismiss={dismiss} />)}
      </ol>
    </Ctx.Provider>
  );
}

function ToastItem({ item, onDismiss: dismiss }: { item: Item; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const onDismiss = useCallback(() => dismiss(item.id), [dismiss, item.id]);
  const duration = item.duration ?? 5000;
  useEffect(() => {
    if (!duration || paused) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [duration, paused, onDismiss]);
  return (
    <li className="sf-toast" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      {item.tone ? <Dot tone={item.tone} className="sf-toast-dot" /> : null}
      <div className="sf-toast-text">
        <div className="sf-toast-title">{item.title}</div>
        {item.description ? <div className="sf-toast-desc">{item.description}</div> : null}
      </div>
      {item.action ? <button type="button" className="sf-toast-action" onClick={() => { item.action!.onClick(); onDismiss(); }}>{item.action.label}</button> : null}
      <IconButton label="Dismiss" size="sm" onClick={onDismiss}><CloseIcon /></IconButton>
    </li>
  );
}
