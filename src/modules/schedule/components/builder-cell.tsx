"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { buttonClasses } from "@/platform/ui/button";
import { cx } from "@/platform/ui/cx";
import type { BuilderAssignmentEntry } from "@/modules/schedule/services/builder";
import {
  SHIFT_TAG_KEYS,
  TAG_SHORT,
  roleFillClasses,
  tagChipStyle,
} from "./shift-colors";

// ---------------------------------------------------------------------------
// BuilderCell
// ---------------------------------------------------------------------------
// A tiny client island: a <form> wrapping a submit button that posts a server
// action with hidden inputs. useFormStatus disables the button while pending.
//
// Variants:
//   assign      -- standard outline button (Saturday view assign action).
//   tag         -- compact toggle button (Saturday view tag toggles).
//   remove      -- danger button.
//   grid        -- compact grid cell: empty slot, shows "+".
//   grid-filled -- compact grid cell: filled slot, shows role glyph + tag dots.

type Variant = "assign" | "tag" | "remove" | "grid" | "grid-filled";

type Props = {
  action: (fd: FormData) => Promise<void>;
  hidden: Record<string, string>;
  label: string;
  pressed?: boolean;
  variant?: Variant;
  /** Accessible label for grid cells (overrides the visible label). */
  ariaLabel?: string;
  /**
   * For grid-filled variant: the current assignment state so the button
   * can render role glyph + tag dots inline.
   */
  assignment?: BuilderAssignmentEntry;
};

/**
 * Filled grid cell with a two-click arm/confirm unassign (mirrors ConfirmButton).
 *
 * First click: type="button", arms the cell (red bg + "Remove?" / "✕") and
 * starts a 3s auto-reset timer; does NOT submit. Second click within the
 * window: type="submit", posts the unassign action. This gives the grid the
 * same accidental-removal protection the Saturday view gets from ConfirmButton,
 * without a hover-only affordance that is invisible on touch.
 */
function GridFilledButton({
  label,
  ariaLabel,
  assignment,
  pending,
}: {
  label: string;
  ariaLabel?: string;
  assignment?: BuilderAssignmentEntry;
  pending: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function arm() {
    setArmed(true);
    clearTimer();
    timerRef.current = setTimeout(() => {
      setArmed(false);
      timerRef.current = null;
    }, 3000);
  }

  // Clean up on unmount.
  useEffect(() => () => clearTimer(), []);

  const activeTags = assignment
    ? SHIFT_TAG_KEYS.filter((t) => assignment.tags[t])
    : [];

  if (armed) {
    return (
      <button
        type="submit"
        disabled={pending}
        aria-label={`Confirm remove. ${ariaLabel ?? label}`}
        // eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button
        className="flex h-9 w-full min-w-[40px] touch-manipulation items-center justify-center rounded-lg border border-critical/30 bg-critical-faint text-critical transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        title="Click again to remove"
      >
        <span className="text-xs font-semibold leading-none">
          {pending ? "..." : "Remove?"}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={(e) => {
        e.preventDefault();
        arm();
      }}
      aria-label={ariaLabel ?? label}
      // eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button
      className={cx(
        "flex h-9 w-full min-w-[40px] touch-manipulation flex-col items-center justify-center rounded-lg border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        // Role tint, so a term of cells says at a glance which are volunteers and
        // which are shadows. Falls back to the old neutral fill when the caller
        // did not pass an assignment (nothing does today, but the prop is
        // optional and a colourless cell beats a crash).
        assignment
          ? roleFillClasses(assignment.role)
          : "border-border-strong bg-muted-strong text-foreground-soft",
        // Removal is still the action, so the hover state still says red.
        "hover:border-critical/30 hover:bg-critical-faint hover:text-critical-foreground",
      )}
      title={ariaLabel ?? label}
    >
      {pending ? (
        <span className="text-xs">...</span>
      ) : (
        <>
          <span className="text-xs font-semibold leading-none">{label}</span>
          {activeTags.length > 0 && (
            <span className="mt-0.5 inline-flex gap-0.5">
              {activeTags.map((t) => (
                <span
                  key={t}
                  style={tagChipStyle(t)}
                  className="rounded-sm px-0.5 text-[10px] font-semibold leading-tight"
                >
                  {TAG_SHORT[t]}
                </span>
              ))}
            </span>
          )}
        </>
      )}
    </button>
  );
}

function SubmitButton({
  label,
  pressed,
  variant,
  ariaLabel,
  assignment,
}: {
  label: string;
  pressed?: boolean;
  variant?: Variant;
  ariaLabel?: string;
  assignment?: BuilderAssignmentEntry;
}) {
  const { pending } = useFormStatus();

  if (variant === "grid") {
    // Empty grid cell: compact "+" to assign.
    return (
      <button
        type="submit"
        disabled={pending}
        aria-label={ariaLabel ?? label}
        // eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button
        className="flex h-9 w-full min-w-[40px] touch-manipulation items-center justify-center rounded-lg border border-dashed border-border-strong text-subtle-foreground hover:border-brand hover:text-brand-fg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {pending ? "..." : "+"}
      </button>
    );
  }

  if (variant === "grid-filled") {
    return (
      <GridFilledButton
        label={label}
        ariaLabel={ariaLabel}
        assignment={assignment}
        pending={pending}
      />
    );
  }

  const cls =
    variant === "tag"
      ? buttonClasses(
          pressed ? "primary" : "outline",
          "sm",
          "text-xs px-2 py-0.5",
        )
      : variant === "remove"
        ? buttonClasses("danger", "sm")
        : buttonClasses("outline", "sm");

  return (
    <button
      type="submit"
      disabled={pending}
      // eslint-disable-next-line no-restricted-syntax -- submit button styled via buttonClasses from platform/ui; useFormStatus requires a raw button element
      className={cls}
      aria-pressed={pressed}
      aria-label={ariaLabel}
    >
      {pending ? "..." : label}
    </button>
  );
}

export function BuilderCell({
  action,
  hidden,
  label,
  pressed,
  variant,
  ariaLabel,
  assignment,
}: Props) {
  return (
    <form action={action} className="inline w-full">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton
        label={label}
        pressed={pressed}
        variant={variant}
        ariaLabel={ariaLabel}
        assignment={assignment}
      />
    </form>
  );
}
