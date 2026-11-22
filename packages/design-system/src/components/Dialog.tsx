import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconButton } from './Button.tsx';
import { CloseIcon } from './icons.tsx';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** No visible header or close button; the title still names the dialog. For the command menu. */
  bare?: boolean;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** center = modal dialog, sheet = full-height panel from the right (full screen under 640px). */
  variant?: 'center' | 'sheet';
  className?: string;
}

/**
 * Native <dialog> opened with showModal(): focus trap, Escape, inert background and focus return come from the platform.
 * Content mounts only while open, so state inside resets on close.
 */
export function Dialog({ open, onClose, title, bare, description, footer, children, variant = 'center', className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={cx('sf-dialog', className)} data-variant={variant} data-bare={bare || undefined}
      aria-labelledby={`${id}-t`} aria-describedby={description ? `${id}-d` : undefined}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {open ? (
        <div className="sf-dialog-in">
          {bare ? <h2 id={`${id}-t`} className="sf-sr-only">{title}</h2> : (
            <header className="sf-dialog-head">
              <div className="sf-dialog-titles">
                <h2 id={`${id}-t`} className="sf-dialog-title">{title}</h2>
                {description ? <p id={`${id}-d`} className="sf-dialog-desc">{description}</p> : null}
              </div>
              <IconButton label="Close" size="sm" onClick={onClose}><CloseIcon /></IconButton>
            </header>
          )}
          {children ? <div className={bare ? undefined : 'sf-dialog-body'}>{children}</div> : null}
          {footer ? <footer className="sf-dialog-foot">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Side panel for run detail: a Dialog with variant="sheet". */
export const Sheet = (p: Omit<DialogProps, 'variant'>) => <Dialog {...p} variant="sheet" />;
