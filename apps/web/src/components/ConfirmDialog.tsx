import { useEffect, useRef } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Minimal accessible confirm modal (Radix AlertDialog is the eventual choice; this keeps deps small). */
export function ConfirmDialog({
  open, title, message, confirmLabel = 'Yes', cancelLabel = 'No', onConfirm, onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return; }
      // Enter is NOT a global "Yes" accelerator — only the focused confirm button confirms, so Enter
      // while focus is on Cancel (or anywhere) can't trigger the destructive reset.
      if (e.key === 'Enter' && document.activeElement === confirmRef.current) { onConfirm(); return; }
      // Trap Tab inside the dialog (the page behind is not inert) so focus can't escape an aria-modal.
      if (e.key === 'Tab' && dialogRef.current) {
        const f = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  }, [open, onCancel, onConfirm]);

  if (!open) return null;
  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={dialogRef} className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
        <div className="muted">{message}</div>
        <div className="modal-actions">
          <button className="text-button" onClick={onCancel}>{cancelLabel}</button>
          <button ref={confirmRef} className="text-button" onClick={onConfirm}
            style={{ borderColor: 'var(--dbg-stop)', color: 'var(--dbg-stop)' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
