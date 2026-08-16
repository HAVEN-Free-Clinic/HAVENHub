"use client";

import { useEffect, type RefObject } from "react";

/**
 * Selector for controls that can actually take focus.
 *
 * Every `:not([disabled])` and the `input[type="hidden"]` exclusion were added in
 * audit 14. The original list only guarded `button`, so a disabled input/select/
 * textarea, and every hidden input a form carries (CSRF-style tokens, server-action
 * bookkeeping fields, the hidden id inputs our row forms post), all counted as
 * focusable. That skews `first` and `last`: a panel whose real last control is a
 * Save button but whose markup ends in a hidden input would wrap Shift+Tab onto the
 * hidden input, `.focus()` on which does nothing, leaving focus where it was and the
 * wrap silently broken.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

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
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        // `hidden` is not expressible in the selector above without repeating it on
        // every branch, and a hidden node is exactly as unfocusable as a disabled one.
        (el) => !el.hasAttribute("hidden"),
      );

      // No focusable control left in the panel. This is NOT a reason to stand down:
      // it is most often a one-button dialog whose button just went `disabled` for
      // the duration of its own submit, which is precisely the window the trap
      // exists to cover (audit 14). Standing down here handed Tab to the browser,
      // which walked focus into the scroll-locked page behind the scrim. The panel
      // itself is focusable (Modal and BlockerGate both set tabIndex={-1}), so park
      // focus there and keep the trap closed until a control comes back.
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const focused = document.activeElement;

      // Focus escaped the panel: pull it straight back in before the browser
      // default runs. See the #79 note above.
      if (!focused || !panel.contains(focused)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (focused === first || focused === panel)) {
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
