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
 * Resets to clean on remount: a successful save reloads the page.
 */
export function useFormDirty(formId: string): boolean {
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return;

    const markDirty = () => setDirty(true);
    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button[type="button"]')) setDirty(true);
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

  return dirty;
}
