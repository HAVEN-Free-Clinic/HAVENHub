"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "./button";
import { Spinner } from "./spinner";

type ConfirmButtonProps = Omit<ComponentProps<typeof Button>, "type" | "variant"> & {
  /** Label shown in the idle state (e.g. "Remove"). */
  label: string;
  /** Label shown in the armed/confirm state. Defaults to "Confirm?". */
  confirmLabel?: string;
  /** How long (ms) the armed state stays open before auto-resetting. Default 3000. */
  timeout?: number;
};

/**
 * Destructive-action button that requires two separate clicks.
 *
 * First click arms the button (danger styling, "Confirm?" label). A second click
 * within the timeout submits the surrounding form; otherwise it auto-resets.
 *
 * Implemented as ONE stable <Button> whose type/variant/label change between the
 * idle and armed states, rather than swapping between two different component
 * types. Two component types at the same position force React to unmount the idle
 * subtree and mount a new armed one, which destroys the focused DOM node and drops
 * a keyboard/AT user to <body> with no way back to the confirm step (#12). Keeping
 * one element means React updates attributes in place, so focus is preserved; the
 * label lives in an aria-live region so the armed change is announced.
 *
 * It reads useFormStatus() itself so it can disable BOTH states while the confirmed
 * action is in flight and cancel the auto-reset timer, rather than reverting the
 * armed (disabled + spinner) SubmitButton to a live idle button mid-action and
 * letting a second click double-fire the destructive/email action (#78).
 *
 * Must be rendered inside a <form>; useFormStatus reads that form's state. Does NOT
 * use window.confirm, so it stays automation-friendly.
 */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm?",
  timeout = 3000,
  className,
  onClick,
  disabled,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const { pending } = useFormStatus();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPending = useRef(false);

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
    }, timeout);
  }

  // Clean up on unmount.
  useEffect(() => () => clearTimer(), []);

  // While the confirmed action is in flight, cancel the auto-reset so the armed +
  // disabled state can't revert to a live idle control mid-action (#78); disarm once
  // it settles (for actions that don't navigate away).
  useEffect(() => {
    if (pending) {
      clearTimer();
      wasPending.current = true;
    } else if (wasPending.current) {
      wasPending.current = false;
      setArmed(false);
    }
  }, [pending]);

  return (
    <Button
      {...rest}
      type={armed ? "submit" : "button"}
      variant={armed ? "danger" : "outline"}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending}
      onClick={(e) => {
        onClick?.(e);
        if (armed) {
          // Confirm click: let the native form submit proceed, but stop the timer
          // from disarming us before the action's pending state takes over.
          clearTimer();
        } else {
          e.preventDefault();
          arm();
        }
      }}
    >
      <span aria-live="polite" className="inline-flex items-center gap-2">
        {pending && <Spinner size="sm" />}
        {armed ? confirmLabel : label}
      </span>
    </Button>
  );
}
