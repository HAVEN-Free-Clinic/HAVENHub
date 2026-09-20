"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * A form whose save keeps you where you are.
 *
 * The ordinary pattern in this app is a server action that redirects, which the
 * flash toast then reports. That is right for a page whose job is finished by
 * the save (a decision, a check-in), and wrong for an editor: a redirect is a
 * navigation, and a navigation scrolls to the top, so saving one question near
 * the bottom of a long course threw the editor back to the page header every
 * time. Asked for by Jack on 2026-09-19 after living with it.
 *
 * So the action behind this form revalidates instead of redirecting: the page
 * re-renders in place with the saved values and the scroll position survives.
 * That loses the toast, which was the only confirmation, so this puts a quiet
 * "Saved" beside the button for a few seconds instead.
 *
 * Errors still redirect (the action's errorRedirect), so a failure is still
 * reported the loud way, and `saved` never appears for one: a thrown redirect
 * skips the state update below.
 */
export function SaveForm({
  action,
  children,
  className,
  savedLabel = "Saved",
}: {
  /** A server action that REVALIDATES rather than redirecting on success. */
  action: (formData: FormData) => Promise<void>;
  children: ReactNode;
  className?: string;
  savedLabel?: string;
}) {
  // A counter, not a boolean: saving twice in a row has to restart the timer,
  // and a boolean that is already true is not a state change, so the effect
  // below would not re-run and the second save would inherit the first one's
  // remaining time. Zero means "say nothing".
  const [saves, setSaves] = useState(0);

  // The effect only schedules; it never sets state synchronously, which is
  // what the cascading-render lint rule forbids.
  useEffect(() => {
    if (saves === 0) return;
    const timer = setTimeout(() => setSaves(0), 2500);
    return () => clearTimeout(timer);
  }, [saves]);

  return (
    <form
      className={className}
      action={async (formData) => {
        await action(formData);
        setSaves((n) => n + 1);
      }}
    >
      {children}
      <span role="status" aria-live="polite" className="ml-2 text-xs text-muted-foreground">
        {saves > 0 ? savedLabel : ""}
      </span>
    </form>
  );
}
