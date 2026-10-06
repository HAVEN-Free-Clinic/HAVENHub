"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cx } from "@/platform/ui/cx";
import { MorphHeight } from "@/platform/ui/morph";
import { spring } from "@/platform/ui/motion";
import { modalSizeClass, type ModalSize } from "@/platform/ui/modal-size";
import { useFocusTrap } from "@/platform/ui/use-focus-trap";

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
 * focus to the previously focused element on close.
 *
 * Motion: the panel scales up from 0.96 as the scrim fades in, and plays that in
 * reverse on close, so the DOM node outlives `open` by the length of the exit.
 * Focus restore and the scroll unlock do NOT wait for it; they run the moment
 * `open` goes false. The body is a MorphHeight, so content that changes inside
 * an open dialog (a ViewSwap step, an error appearing) resizes the panel with a
 * spring instead of snapping. Renders nothing once closed and the exit is done.
 */
export function Modal({ open, onClose, title, ariaLabel, size = "default", children, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // Whether the portal is in the DOM: true from the moment `open` flips on until
  // the exit animation finishes. Adjusted during render (React's documented
  // "storing information from previous renders" pattern), not in an effect, so
  // the opening render already has the portal.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus moves into the panel via useFocusTrap, which also owns Tab.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCloseRef.current();
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  // Must run after the effect above: React fires effects in declaration order,
  // and this hook moves focus into the panel. If it ran first, the effect
  // above would capture the panel itself (tabIndex={-1} makes it focusable)
  // as previouslyFocused instead of the element that opened the dialog, and
  // focus restore on close would silently do nothing.
  useFocusTrap(panelRef, open);

  if (!present) return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setPresent(false)}>
      {open && (
        <motion.div
          key="scrim"
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-xs"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={spring.snappy}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={!title ? ariaLabel : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={spring.default}
            className={cx(
              // animate-none: Motion owns this panel's entrance, so the CSS pop-in
              // that every other .float-panel gets must not run on top of it.
              "flex max-h-[90vh] w-full flex-col rounded-2xl float-panel animate-none outline-none",
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
            {/* shrink + min-h-0: the animated height is a target, and the panel's
                max-h still wins when content outgrows the viewport; the body then
                scrolls instead of pushing the footer off screen. */}
            <MorphHeight className="min-h-0 shrink overflow-y-auto" innerClassName="p-4">
              {children}
            </MorphHeight>
            {footer && (
              <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
