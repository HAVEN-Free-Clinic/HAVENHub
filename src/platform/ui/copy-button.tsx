"use client";

import { useState } from "react";
import { Button } from "./button";
import { cx } from "./cx";

/**
 * Copy a value to the clipboard and say honestly whether it worked.
 *
 * Five surfaces wrote this by hand, in three shapes, and two of the pairs were
 * byte-identical to each other. All five already got the important part right
 * -- the write is awaited inside a try/catch, so none of them claims a copy
 * that did not happen -- but five copies of a `navigator.clipboard` guard, a
 * state machine, a timer and an `aria-live` region is five chances for the next
 * one to forget a piece.
 *
 * ## The clipboard genuinely fails
 *
 * Not a theoretical branch: `navigator.clipboard` is undefined on an insecure
 * origin, and `writeText` rejects on a denied permission or a locked-down
 * browser. The guard is explicit rather than relying on the rejection, because
 * on an insecure origin the property is missing and the call would throw a
 * TypeError before any promise existed.
 *
 * ## One knob, because there are exactly two honest policies
 *
 * - **The value is on screen** in a selectable field (an address box, a feed
 *   URL). A failed copy costs the reader one drag, so it says nothing and the
 *   label simply does not change. Claiming success would be the only real bug.
 * - **The value is not recoverable** -- a single-use invite link shown for
 *   exactly one render, or a long generated email draft. Then the failure has
 *   to be spoken, and it has to point somewhere: pass the sentence.
 *
 * Passing `errorMessage` is what selects the second policy. There is no
 * `feedback` or `variant` prop deciding where the message goes, because a knob
 * per call site is not a primitive.
 *
 * ## Success clears itself; an error does not
 *
 * "Copied" is a receipt for something that already happened, so it fades after
 * two seconds. A failure is a thing still to do, and the reader may look back
 * at the screen long after four seconds -- the invite panel's whole point is
 * that leaving the page loses the link. So the error stays until the next
 * attempt.
 *
 * The `role="status"` region exists because the button's own label change is
 * NOT reliably re-announced while it still has focus, which is exactly when it
 * changes.
 */
export function CopyButton({
  value,
  label = "Copy",
  /** Say this when the write fails. Omit when the value is on screen anyway. */
  errorMessage,
  size = "sm",
  variant = "outline",
  className,
  buttonClassName,
}: {
  value: string;
  label?: string;
  errorMessage?: string;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "outline" | "ghost" | "danger";
  /** On the wrapper. */
  className?: string;
  /** On the button itself, for callers that size it down in a dense row. */
  buttonClassName?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setState("copied");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      // Silent unless the caller says otherwise: see the note above on the two
      // policies. Either way the label does not lie.
      setState(errorMessage ? "error" : "idle");
    }
  }

  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={variant}
          size={size}
          className={buttonClassName}
          onClick={copy}
        >
          {state === "copied" ? "Copied" : label}
        </Button>
        <span role="status" className="sr-only">
          {state === "copied" ? "Copied to clipboard" : ""}
        </span>
      </div>
      {state === "error" && errorMessage && (
        <p role="alert" className="text-sm text-critical-foreground">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
