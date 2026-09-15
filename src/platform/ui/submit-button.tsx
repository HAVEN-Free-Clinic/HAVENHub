"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { Button } from "./button";
import { Spinner } from "./spinner";

type SubmitButtonProps = Omit<ComponentProps<typeof Button>, "type"> & {
  /** Label shown while THIS button's action is in flight. */
  pendingLabel?: string;
};

/**
 * Whether this button's own action is the one in flight.
 *
 * Exported only so it can be tested: `useFormStatus` returns nothing useful
 * outside a real form submission, so the component itself cannot be driven in
 * vitest, and a rule this easy to invert quietly is worth a test that can fail.
 */
export function ownsPendingSubmit(
  pending: boolean,
  action: unknown,
  formAction: unknown,
): boolean {
  return pending && (formAction === undefined || action === formAction);
}

/**
 * Submit button that disables itself and swaps to a pending label (with a
 * spinner) while its form's server action is in flight. Prevents double-submits
 * and gives users feedback that something is happening.
 *
 * Must be rendered inside a <form>; useFormStatus reads that form's state.
 *
 * ## Which button is running
 *
 * `pending` from useFormStatus is the FORM's, so in a form with two submits it
 * is true on both. The label, though, is per button: `action` is the function
 * that actually initiated this submit, and react-dom sets it to the SUBMITTER's
 * `formAction` prop when the submitter has one -- the same object this component
 * was handed -- so `action === formAction` identifies the clicked button by
 * reference (react-dom-client, the submit dispatch in `extractEvents`).
 *
 * A button with no `formAction` cannot be told apart that way and claims any
 * submit, which is right for the overwhelmingly common one-submit form. In a
 * form with two, give BOTH buttons an explicit `formAction` -- including the one
 * whose action is already the form's -- or the plain one will say "Saving…"
 * while the other button's action is what is running. That is the bug this
 * replaced: both forms of it had been papered over by giving each button a noun
 * for a pendingLabel so at least the words did not lie.
 *
 * `disabled` deliberately stays on the FORM's pending, not this button's: while
 * anything in the form is in flight, nothing else in it should be submittable.
 *
 * ## Do not pair `formAction` with `name`/`value`
 *
 * react-dom drops the submitter when it takes an action off it, so a button
 * carrying both sends its `name`/`value` NOWHERE -- silently, with the action
 * still running and reading an empty string. Verified against react-dom 19.2.4;
 * `submit-button.guard.test.ts` fences the pairing. To hand a row id to a
 * per-row action, bind it: `formAction={cancelAction.bind(null, row.id)}`, which
 * also gives that row its own pending state for free.
 */
export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  formAction,
  ...rest
}: SubmitButtonProps) {
  const { pending, action } = useFormStatus();
  const mine = ownsPendingSubmit(pending, action, formAction);
  return (
    <Button {...rest} formAction={formAction} type="submit" disabled={pending || disabled} aria-busy={mine}>
      <span className="inline-flex items-center gap-2">
        {mine && <Spinner size="sm" />}
        {mine ? (pendingLabel ?? "Saving…") : children}
      </span>
    </Button>
  );
}
