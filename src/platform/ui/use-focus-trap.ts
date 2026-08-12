"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, iframe, [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside `panelRef` while `active`, and moves focus into the panel
 * when it becomes active.
 *
 * Shared by Modal and BlockerGate rather than copied into each, because it
 * carries a fix that is not obvious from reading it (#79): the browser blurs
 * to <body> whenever the focused control is removed or disabled, which every
 * in-flight action button does while its transition runs. Without the
 * pull-back below, Tab from <body> walks into the scroll-locked page behind
 * the scrim. A second copy of this would not inherit the next such fix.
 *
 * Escape handling and scroll locking deliberately stay with the caller: Modal
 * closes on Escape, and BlockerGate must not.
 */
export function useFocusTrap(panelRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;

    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const focused = document.activeElement;

      // Focus escaped the panel: pull it straight back in before the browser
      // default runs. See the #79 note above.
      if (!focused || !panelRef.current?.contains(focused)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (focused === first || focused === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && focused === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [panelRef, active]);
}
