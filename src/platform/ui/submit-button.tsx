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
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <Spinner size="sm" />
          {pendingLabel ?? "Saving…"}
        </span>
      ) : (
        children
      )}
    </Button>
  );
}
