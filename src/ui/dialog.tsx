import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { IconClose } from './icons.tsx';

type DialogProps = Readonly<{
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  drawer?: boolean;
  /** While locked (e.g. a save transaction is in flight), the close button is
   *  disabled and Escape/backdrop are blocked, so closing never implies
   *  cancelling an accepted write. */
  locked?: boolean;
}>;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog with name, visible close button, focus trap, Escape and focus restore. */
export function Dialog(props: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const lockedRef = useRef(!!props.locked);
  lockedRef.current = !!props.locked;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const initial = el.querySelector<HTMLElement>('[data-autofocus]') ?? items()[0] ?? el;
    initial.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (!lockedRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = items();
      if (!focusables.length) { event.preventDefault(); return; }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('keydown', onKeyDown);
      restore?.focus();
    };
  }, []);

  const className = props.drawer ? 'dialog dialog-drawer' : props.wide ? 'dialog dialog-wide' : 'dialog';
  return (
    <div className="scrim" onMouseDown={event => {
      if (event.target === event.currentTarget && !lockedRef.current) onCloseRef.current();
    }}>
      <div className={className} role="dialog" aria-modal="true"
        aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="dlg-title">
          <h2 id={titleId}>{props.title}</h2>
          <button type="button" className="btn icon sm dlg-close" aria-label="关闭"
            disabled={!!props.locked} onClick={() => onCloseRef.current()}>
            <IconClose />
          </button>
        </div>
        <div className="dlg-body">{props.children}</div>
        {props.footer && <div className="dlg-actions">{props.footer}</div>}
      </div>
    </div>
  );
}
