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
  /**
   * Called by the confirm click instead of submitting a form.
   *
   * For destructive actions that are a function call rather than a form post --
   * the interactive Schedule Builder writes over fetch, so its Remove buttons
   * have no form to submit. Everything else about the control is unchanged: same
   * two-click arming, same one-element identity, same focus-driven disarm. When
   * omitted the button submits its surrounding form, as it always has.
   */
  onConfirm?: () => void;
  /**
   * In-flight flag for the onConfirm form of the button, standing in for the
   * useFormStatus reading a form would give it. Ignored inside a form.
   */
  busy?: boolean;
};

/**
 * Destructive-action button that requires two separate clicks.
 *
 * First click arms the button (danger styling, "Confirm?" label). A second click
 * submits the surrounding form.
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
 * action is in flight, rather than reverting the armed (disabled + spinner)
 * SubmitButton to a live idle button mid-action and letting a second click
 * double-fire the destructive/email action (#78).
 *
 * The armed state used to auto-reset on a 3s timer. That timer was removed in audit
 * 14: 3s is shorter than a screen reader takes to finish speaking the aria-live
 * "Confirm?" announcement, let alone to then move to the control and activate it, so
 * the button had always disarmed itself again by the time an AT user could reach the
 * confirm step. The result was that NO destructive action anywhere in the app was
 * completable by screen reader, since every one of them routes through this button.
 * Nothing replaces the timer as a clock (a timed disarm is a WCAG 2.2.1 time limit no
 * matter how long it runs). The self-heal that keeps a stray armed button from
 * sitting hot is now event-driven instead: moving focus off the control disarms it.
 * That is reachable by mouse, keyboard, and AT alike, and cannot expire under a user
 * who is simply reading slowly.
 *
 * Must be rendered inside a <form>; useFormStatus reads that form's state. The one
 * exception is the `onConfirm` form of the button, which calls a handler instead and
 * takes its in-flight state from `busy`. Does NOT use window.confirm, so it stays
 * automation-friendly.
 */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm?",
  className,
  onClick,
  onBlur,
  disabled,
  onConfirm,
  busy,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const formStatus = useFormStatus();
  // Outside a form useFormStatus reports pending: false forever, so the caller's
  // own flag is what keeps the confirm state disabled while the action runs.
  const pending = onConfirm ? (busy ?? false) : formStatus.pending;
  const wasPending = useRef(false);
  // Set synchronously by the confirm click, BEFORE React re-renders with
  // pending=true. Submitting disables the button, the browser blurs the disabled
  // node to <body>, and that blur would otherwise disarm us mid-flight and flip the
  // control back to its idle look while the destructive action is still running --
  // the exact state #78 exists to prevent. Reading a ref (not the `pending` state)
  // makes the guard independent of whether the blur lands before or after that
  // re-render.
  const confirming = useRef(false);

  // Disarm once the action settles, for actions that do not navigate away (#78).
  useEffect(() => {
    if (pending) {
      wasPending.current = true;
    } else if (wasPending.current) {
      wasPending.current = false;
      confirming.current = false;
      setArmed(false);
    }
  }, [pending]);

  return (
    <Button
      {...rest}
      type={armed && !onConfirm ? "submit" : "button"}
      variant={armed ? "danger" : "outline"}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending}
      onClick={(e) => {
        onClick?.(e);
        if (armed) {
          // Confirm click: let the native form submit proceed, or call the
          // handler when there is no form behind this button.
          confirming.current = true;
          if (onConfirm) {
            e.preventDefault();
            setArmed(false);
            confirming.current = false;
            onConfirm();
          }
        } else {
          e.preventDefault();
          setArmed(true);
        }
      }}
      onBlur={(e) => {
        onBlur?.(e);
        if (confirming.current || pending) return;
        setArmed(false);
      }}
    >
      <span aria-live="polite" className="inline-flex items-center gap-2">
        {pending && <Spinner size="sm" />}
        {armed ? confirmLabel : label}
      </span>
    </Button>
  );
}
