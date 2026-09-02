"use client";

import { useEffect, useState } from "react";

/**
 * Tracks whether the form with the given id has unsaved edits.
 *
 * Catches native input/change events plus structural type="button" clicks
 * (add/remove audience condition, match toggle, rich-text toolbar, variable
 * chips) that fire no input event. Every action that reads the campaign from the
 * database -- preview, test, send, schedule, recurring -- must gate on this so it
 * cannot silently act on the last-saved version while the compose form is dirty.
 *
 * `savedAt` is how a caller says "everything up to here has been persisted":
 * pass the campaign's updatedAt, and the flag drops back to false whenever the
 * server hands down a newer one. Callers that omit it get the original
 * behaviour, which has no path back to false on its own and therefore has to be
 * REMOUNTED by its parent to reset (ReviewActions and TimingActions are keyed
 * on updatedAt for exactly that, #14).
 *
 * The reset argument exists because a remount is not free for every consumer. A
 * component holding an uncontrolled input -- the recipient panel's paste box --
 * loses the text in it every time the key changes, and manual-list actions bump
 * updatedAt without the sender having touched the compose form at all. Passing
 * savedAt lets that panel reconcile across the soft nav instead of remounting,
 * which is what keeps a half-typed block of addresses alive.
 */
export function useFormDirty(formId: string, savedAt?: string): boolean {
  // The two questions live in one state object so they can only ever move
  // together: "is it dirty" and "which saved version was that judged against".
  const [tracked, setTracked] = useState({ dirty: false, savedAt });

  // Derived during render rather than in an effect, so a re-render carrying a
  // newer savedAt reports clean IMMEDIATELY. An effect would let one paint go
  // out with the controls still disabled straight after a successful save,
  // which is the papercut the remount was hiding.
  if (tracked.savedAt !== savedAt) {
    setTracked({ dirty: false, savedAt });
  }

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return;

    const markDirty = () => setTracked((t) => ({ ...t, dirty: true }));
    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button[type="button"]')) markDirty();
    };

    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    form.addEventListener("click", onClick);
    return () => {
      form.removeEventListener("input", markDirty);
      form.removeEventListener("change", markDirty);
      form.removeEventListener("click", onClick);
    };
  }, [formId]);

  return tracked.dirty;
}
