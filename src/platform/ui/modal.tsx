"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "@/platform/ui/cx";
import { modalSizeClass, type ModalSize } from "@/platform/ui/modal-size";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Accessible name for the dialog when `title` is omitted (role="dialog" must always be named). */
  ariaLabel?: string;
  /** Panel width. `large` (max-w-6xl) suits dense reviewer content. Default `default` (max-w-4xl). */
  size?: ModalSize;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Accessible modal dialog. Renders via a portal to document.body, traps focus,
 * closes on Escape and backdrop click, locks body scroll while open, and restores
 * focus to the previously focused element on close. Renders nothing when closed.
 */
export function Modal({ open, onClose, title, ariaLabel, size = "default", children, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus into the dialog on open.
    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Minimal focus trap: keep Tab within the panel.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, iframe, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      // Focus escaped the panel: the browser blurs to <body> whenever the focused
      // control is removed or becomes disabled -- which every in-flight action button
      // in every modal does while its transition runs. Without this, Tab from <body>
      // walks into the scroll-locked page behind the scrim (Skip-to-content, the roster
      // behind a Speed score/route or Certificate viewer). Pull it straight back in
      // before the browser default runs (#79).
      if (!active || !panelRef.current?.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" /* fixed dark scrim: must not theme-flip */
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        tabIndex={-1}
        className={cx(
          "flex max-h-[90vh] w-full flex-col rounded-2xl glass-panel outline-none",
          modalSizeClass(size),
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold text-foreground-soft">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted-strong hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
