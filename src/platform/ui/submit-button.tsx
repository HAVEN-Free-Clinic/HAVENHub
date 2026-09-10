"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { Button } from "./button";
import { Spinner } from "./spinner";

type SubmitButtonProps = Omit<ComponentProps<typeof Button>, "type"> & {
  /** Label shown while the surrounding form's server action is pending. */
  pendingLabel?: string;
};

/**
 * Submit button that disables itself and swaps to a pending label (with a
 * spinner) while the surrounding <form>'s server action is in flight. Prevents
 * double-submits and gives users feedback that something is happening.
 *
 * Must be rendered inside a <form>; useFormStatus reads that form's state.
 *
 * `pending` is the FORM's, not this button's, so in a form with two submits
 * (one overriding via `formAction`) both buttons go pending together and a
 * pendingLabel that reads as a verb -- "Saving…" -- can end up describing the
 * other button's action. The two such forms in the app (/admin/email's
 * send-from rows and the template editor's) give each button its own noun as
 * its pendingLabel and let the spinner carry the feedback.
 *
 * If a caller ever needs a true per-button pending, useFormStatus also returns
 * `action`: the function that initiated the submit, comparable against the
 * button's own. That is a prop this component does not take today.
 */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...rest
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button {...rest} type="submit" disabled={pending || disabled} aria-busy={pending}>
      <span className="inline-flex items-center gap-2">
        {pending && <Spinner size="sm" />}
        {pending ? (pendingLabel ?? "Saving…") : children}
      </span>
    </Button>
  );
}
