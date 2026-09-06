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
   * Non-form use: run this on the confirm click instead of submitting a form.
   *
   * Without it the confirm click submits the surrounding <form>, which is the
   * common case. Pass it for a destructive action that is a plain client
   * handler with no form behind it (clearing an unsaved draft, resetting an
   * editor). The button then never becomes type="submit", so it cannot submit
   * an unrelated ancestor form by accident.
   */
  onConfirm?: () => void;
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
 * Rendered inside a <form> by default; useFormStatus reads that form's state. For a
 * destructive action with no form behind it, pass `onConfirm` instead and the confirm
 * click calls that rather than submitting. Does NOT use window.confirm, so it stays
 * automation-friendly.
 *
 * Reach for this for EVERY two-click destructive confirmation. Hand-rolling one has
 * gone wrong the same two ways every time: swapping between two component types at
 * one position (which is #12 again, focus to <body>), and adding a timed auto-disarm
 * (which is the WCAG 2.2.1 time limit audit 14 removed). Both are invisible to the
 * author and total for a keyboard or screen-reader user.
 */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm?",
  className,
  onClick,
  onBlur,
  onConfirm,
  disabled,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const { pending } = useFormStatus();
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
      // Stays "button" in the onConfirm case: there is no form to submit, and a
      // stray type="submit" would post whatever ancestor form it found.
      type={armed && !onConfirm ? "submit" : "button"}
      variant={armed ? "danger" : "outline"}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending}
      onClick={(e) => {
        onClick?.(e);
        if (armed) {
          if (onConfirm) {
            // No form, so nothing will flip `pending` and drive the disarm
            // effect below. Disarm here instead, after the handler runs.
            e.preventDefault();
            onConfirm();
            setArmed(false);
          } else {
            // Confirm click: let the native form submit proceed.
            confirming.current = true;
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
