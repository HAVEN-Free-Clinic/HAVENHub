"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import { cx } from "../cx";
import type { FlashToast, ToastTone } from "./flash";

/**
 * The toast primitive: `ToastProvider` (holds the live queue), `ToastViewport`
 * (renders it), and `useToast()` (the hook client code calls to push one).
 * Mounted in the root layout (`src/app/layout.tsx`); see `flash-reader.tsx`
 * for the URL-driven caller.
 *
 * Design spec sections 5 and 6
 * (docs/superpowers/specs/2026-07-30-toast-notifications-design.md):
 *
 * - Success and info auto-dismiss after ~4s. Error and warning persist until
 *   the user dismisses them and carry a close button: auto-dismissing an
 *   error is a usability failure, since the user may not have been looking
 *   and an error usually needs action. Every toast is also dismissible by
 *   clicking it (the close button is the explicit, keyboard-reachable path
 *   for the tones that never time out on their own).
 * - Up to three toasts are visible at once; a fourth (and beyond) waits in
 *   the queue and only mounts, starting its own dismiss timer, once a slot
 *   opens up.
 * - Tone lives in the leading icon, not a filled background, the same
 *   principle `alert.tsx:31-40` states. This reuses alert.tsx's tone-to-icon
 *   map, but not its tone-to-color map: alert.tsx colors info as
 *   `text-brand-fg`, which in light mode resolves to the exact navy this
 *   pill's `bg-brand-deep` background already is, so it would be invisible
 *   here. The colors below are the theme-invariant "vivid" tokens
 *   (`--color-success` / `--color-warning` / `--color-critical` in
 *   globals.css, plus `--color-info`, defined there but not yet used
 *   anywhere else) that Badge's status dots already rely on for the same
 *   reason: none of the four shift between light and dark mode, so they read
 *   the same against a pill that also never changes color by theme.
 * - `role="alert"` (assertive) for error, `role="status"` (polite) for
 *   everything else, exactly mirroring `alert.tsx:52`.
 * - The pill is deliberately `rounded-full`, not `alert.tsx`'s `rounded-xl`:
 *   the design spec and the reference screenshot both call for a literal
 *   pill, distinct from the inline Alert this system exists to move away
 *   from.
 * - The enter transition (opacity/translate) respects prefers-reduced-motion
 *   via Tailwind's `motion-reduce:` variant, the same mechanism Spinner and
 *   Skeleton already use for their own animations.
 */

const AUTO_DISMISS_MS = 4000;
const MAX_VISIBLE = 3;

function autoDismisses(tone: ToastTone): boolean {
  return tone === "success" || tone === "info";
}

const toneIcon: Record<ToastTone, LucideIcon> = {
  error: XCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
  info: Info,
};

const toneIconColor: Record<ToastTone, string> = {
  error: "text-critical",
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
};

/**
 * What a caller hands to the function `useToast()` returns. Deliberately the
 * same shape as the flash classifier's `FlashToast` (`{ tone, message }`), so
 * the flash reader (a later task) can push classified output straight
 * through with no mapping step, and a page composing its own message can
 * hand the exact same shape.
 */
export type ToastInput = FlashToast;

type ToastRecord = ToastInput & { id: string };

type ToastContextValue = {
  toasts: ToastRecord[];
  push: (input: ToastInput) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

let nextToastId = 0;
function makeToastId(): string {
  nextToastId += 1;
  return `toast-${nextToastId}`;
}

/**
 * Holds the live toast queue and supplies push/dismiss to `useToast()` and
 * `ToastViewport` via context. Wrap the app once, near the root.
 * `ToastViewport` is a separate component so it can be mounted at whatever
 * point in the tree makes sense (e.g. a sibling of `children`, to share a
 * stacking lane with another fixed element), rather than being forced to
 * live wherever the provider itself sits.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((input: ToastInput) => {
    setToasts((current) => [...current, { ...input, id: makeToastId() }]);
  }, []);

  // Memoised so consumers only re-render when the queue itself (or the
  // stable push/dismiss identities) changes, not on every provider render.
  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() and ToastViewport must be rendered inside a ToastProvider.");
  }
  return ctx;
}

/**
 * Pushes a toast from a client component that never round-trips the server:
 * a copy action, a local toggle, a client-only validation. Server-driven
 * page confirmations arrive instead through the flash-param reader (a later
 * task, built on `classifyFlashParams` in `./flash`), which calls this same
 * function with its own classified output.
 */
export function useToast(): (input: ToastInput) => void {
  return useToastContext().push;
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}) {
  const [entered, setEntered] = useState(false);
  const Icon = toneIcon[toast.tone];
  const hasCloseButton = !autoDismisses(toast.tone);

  // Deferred by one tick so the first paint is the "not entered" state and
  // the transition classes below have something to animate from. Setting
  // this directly in the effect body would be a synchronous
  // setState-in-effect (react-hooks/set-state-in-effect is an error in this
  // repo), so the setter runs from the timeout callback, not the effect body
  // itself, the same pattern `help-launcher.tsx` uses for its token refresh.
  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!autoDismisses(toast.tone)) return;
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.tone, toast.id, onDismiss]);

  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      onClick={() => onDismiss(toast.id)}
      className={cx(
        "pointer-events-auto flex w-fit max-w-sm cursor-pointer items-start gap-2.5 rounded-full",
        "bg-brand-deep px-4 py-3 text-sm text-white shadow-lg",
        "transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      <Icon className={cx("mt-px h-4 w-4 shrink-0", toneIconColor[toast.tone])} aria-hidden />
      <span className="flex-1">{toast.message}</span>
      {hasCloseButton && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(toast.id);
          }}
          aria-label="Dismiss notification"
          className="-m-1 shrink-0 rounded-full p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Fixed bottom-center stack. Renders at most `MAX_VISIBLE` toasts at a time;
 * the rest wait in the queue (oldest first) and only mount, starting their
 * own dismiss timer, once a slot frees up, so a queued toast's countdown
 * begins when it becomes visible, not when it was pushed.
 *
 * Portalled to `document.body`, the same fix `HelpLauncher` already applies
 * to its panel: a `fixed` descendant of a `.glass-bar`/`.glass-panel`
 * ancestor loses its viewport anchor because `backdrop-filter` creates a
 * containing block.
 *
 * Gating the portal on a `mounted` flag flipped after the first paint,
 * rather than on `typeof document === "undefined"` directly, is load-bearing,
 * not stylistic: found via the root layout's own hydration once this
 * component was actually mounted there (Task 4). `document` is undefined
 * during SSR but defined the instant client code runs, including React's
 * hydration pass -- checking it directly is React's own textbook hydration-
 * mismatch anti-pattern ("a server/client branch `if (typeof window !==
 * 'undefined')`"), since the server emits nothing for this component while
 * the client's first render already sees `document` and emits the portal.
 * `mounted` starts `false` on both the server and the client's initial
 * (hydration) render, so they agree; only a post-mount effect flips it,
 * strictly after hydration has already reconciled. The setter runs from a
 * zero-delay timeout rather than the effect body itself, the same dodge
 * `ToastItem`'s own `entered` state below uses, since `react-hooks/set-state-
 * in-effect` is an error in this repo.
 */
export function ToastViewport() {
  const { toasts, dismiss } = useToastContext();
  const [mounted, setMounted] = useState(false);
  const visible = toasts.slice(0, MAX_VISIBLE);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timer);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {visible.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}
