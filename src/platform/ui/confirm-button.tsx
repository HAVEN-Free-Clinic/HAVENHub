"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Button } from "./button";

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
 * First click: arms the button (switches to danger styling, "Confirm?" label).
 * Second click (within timeout): submits the surrounding form (type="submit").
 * If the timeout elapses without a second click the button resets silently.
 *
 * Does NOT use window.confirm so it is automation-friendly.
 */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm?",
  timeout = 3000,
  className,
  ...rest
}: ConfirmButtonProps) {
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
    }, timeout);
  }

  // Clean up on unmount.
  useEffect(() => () => clearTimer(), []);

  if (armed) {
    return (
      <Button
        {...rest}
        type="submit"
        variant="danger"
        className={className}
      >
        {confirmLabel}
      </Button>
    );
  }

  return (
    <Button
      {...rest}
      type="button"
      variant="outline"
      onClick={(e) => {
        e.preventDefault();
        arm();
      }}
      className={className}
    >
      {label}
    </Button>
  );
}
