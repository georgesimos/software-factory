import { cloneElement, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  /** One focusable element. It gets aria-describedby pointing at the tip. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'top' | 'bottom';
  /** Hover delay in ms. Keyboard focus shows it at once. */
  delay?: number;
}

/** Hover/focus tooltip that stays inside the viewport and closes on Escape (WCAG 1.4.13). */
export function Tooltip({ content, children, side = 'top', delay = 300 }: TooltipProps) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const show = (wait: number) => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), wait); };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };

  useLayoutEffect(() => {
    const t = tip.current, w = wrap.current;
    if (!open || !t || !w) return;
    const a = w.getBoundingClientRect(), b = t.getBoundingClientRect(), pad = 8;
    const left = Math.min(Math.max(pad, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - pad);
    const above = side === 'top' && a.top - b.height - 6 > pad;
    t.style.left = `${left}px`;
    t.style.top = `${above ? a.top - b.height - 6 : a.bottom + 6}px`;
  }, [open, side]);

  return (
    <span ref={wrap} className="sf-tooltip-anchor"
      onPointerEnter={() => show(delay)} onPointerLeave={hide}
      onFocus={() => show(0)} onBlur={hide}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); hide(); } }}>
      {cloneElement(children, { 'aria-describedby': id })}
      <span ref={tip} id={id} role="tooltip" className="sf-tooltip" data-open={open || undefined}>{content}</span>
    </span>
  );
}
