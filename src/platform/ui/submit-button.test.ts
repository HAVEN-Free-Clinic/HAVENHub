import { describe, expect, it } from "vitest";
import { ownsPendingSubmit } from "./submit-button";

/**
 * Which of a form's submits owns the pending state.
 *
 * `useFormStatus().pending` is the FORM's, so in a two-submit form it is true on
 * both buttons and a verb for a pendingLabel ends up describing whichever action
 * the user did NOT start. `action` is what separates them: react-dom sets it to
 * the submitter's own `formAction` prop, by reference.
 *
 * Verified in a browser against react-dom 19.2.4 before this rule was written --
 * a form with three submits, two carrying distinct formActions, one carrying
 * none. Clicking the second reported `a: no, b: yes, plain: yes`, which is the
 * table below.
 *
 * Two of the five carry the change -- "declines the submit" and "compares by
 * reference" go red against the old `return pending`. The other three pin what
 * must NOT change: an idle form, a button running its own action, and the
 * one-submit form that has no formAction to compare.
 */
describe("ownsPendingSubmit", () => {
  const actionA = async () => {};
  const actionB = async () => {};

  it("is false for every button while the form is idle", () => {
    expect(ownsPendingSubmit(false, undefined, actionA)).toBe(false);
    expect(ownsPendingSubmit(false, undefined, undefined)).toBe(false);
  });

  it("claims the submit when the running action is this button's own", () => {
    expect(ownsPendingSubmit(true, actionA, actionA)).toBe(true);
  });

  it("declines the submit when another button's action is what is running", () => {
    // The whole point: without this, Save says "Saving…" through a test send.
    expect(ownsPendingSubmit(true, actionB, actionA)).toBe(false);
  });

  it("compares by reference, not by shape", () => {
    // Two server actions with identical source are still different actions.
    const twin = async () => {};
    expect(ownsPendingSubmit(true, twin, async () => {})).toBe(false);
  });

  it("claims any submit when the button names no action of its own", () => {
    // Correct for the one-submit form, which is nearly all of them -- and the
    // reason a two-submit form must give BOTH buttons a formAction, including
    // the one whose action is already the form's.
    expect(ownsPendingSubmit(true, actionB, undefined)).toBe(true);
  });
});
