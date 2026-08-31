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
 *   anywhere else). None of the four shift between light and dark mode, so
 *   they read the same against a pill that also never changes color by theme.
 *   Note these are NOT the `*-foreground` variants Badge uses: those are
 *   theme-dependent and tuned for AA as text on the light/dark page surfaces,
 *   which is the opposite of what this fixed-navy pill needs.
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
        // rounded-3xl, not rounded-full. CSS clamps a corner radius to half the
        // box height, so on a single-line pill (about 44px) 24px still renders a
        // full stadium and looks identical to rounded-full, which is the shape
        // the design calls for. On a message that wraps, rounded-full would give
        // a radius of half the pill's height (52px on a four-line toast), curving
        // the left and right edges so far inward that the leading icon and the
        // close button read as spilling outside the pill. Capping the radius
        // keeps the pill shape where it matters and a rounded card where it does not.
        "pointer-events-auto flex w-fit max-w-sm cursor-pointer items-start gap-2.5 rounded-3xl",
        "bg-brand-deep px-4 py-3 text-sm text-white shadow-lg",
        "transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      {/* The icon and the close button each sit in their own 20px box (h-5), which is
          the text's line-height, so all three glyphs share one optical centre line.
          Without it the row is `items-start` against a 20px line box holding 16px
          glyphs, and both the icon and the X ride 1 to 2px high: visibly off on a
          single-line pill. `items-start` on the row is still right, so on a message
          that wraps these align to its first line rather than to the pill's middle. */}
      <span className="flex h-5 shrink-0 items-center">
        <Icon className={cx("h-4 w-4", toneIconColor[toast.tone])} aria-hidden />
      </span>
      <span className="flex-1">{toast.message}</span>
      {hasCloseButton && (
        <span className="flex h-5 shrink-0 items-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(toast.id);
            }}
            aria-label="Dismiss notification"
            // Negative margin keeps the comfortable 24px hit area while letting the
            // wrapper above own the alignment; it overflows symmetrically and is
            // transparent until hover, so it costs nothing visually.
            className="-m-1 rounded-full p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </span>
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
/**
 * The bottom-center lane. Anything passed as `children` renders in the same flex
 * column, directly above the toast stack.
 *
 * That slot exists for the inactivity warning (R12). Both it and the toasts are
 * bottom-center fixed elements, and an earlier version kept them apart by giving
 * the warning a hand-computed `bottom-*` offset sized against the tallest stack
 * the viewport could produce. That arithmetic was wrong twice: it assumed
 * single-line pills, and the registry's longest messages actually wrap to four
 * or five lines. Any fixed offset is a guess about content height. Sharing one
 * flex column removes the guess: flow layout cannot overlap, whatever the
 * messages say and however tall they get.
 */
export function ToastViewport({ children }: { children?: ReactNode }) {
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
      {children}
      {visible.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}
