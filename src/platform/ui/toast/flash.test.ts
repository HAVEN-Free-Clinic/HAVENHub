import { describe, it, expect } from "vitest";
import { classifyFlashParams } from "./flash";

/** Build a URLSearchParams from a plain object, the shape every test needs. */
function paramsOf(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

/** A pathname no registry entry is scoped to, for tests that don't care about scoping. */
const NEUTRAL_PATHNAME = "/some/page";

describe("classifyFlashParams", () => {
  it("claims error, error tone, message is the param's own decoded value", () => {
    const result = classifyFlashParams(paramsOf({ error: "Something went wrong" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "error", message: "Something went wrong" }]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("claims rosterError by the /Error$/ convention", () => {
    const result = classifyFlashParams(
      paramsOf({ rosterError: "Roster line 4 is invalid." }),
      NEUTRAL_PATHNAME,
    );
    expect(result.toasts).toEqual([{ tone: "error", message: "Roster line 4 is invalid." }]);
    expect(result.stripParams).toEqual(["rosterError"]);
  });

  it("claims rbacError by the /Error$/ convention", () => {
    const result = classifyFlashParams(
      paramsOf({ rbacError: "That grant already exists." }),
      NEUTRAL_PATHNAME,
    );
    expect(result.toasts).toEqual([{ tone: "error", message: "That grant already exists." }]);
    expect(result.stripParams).toEqual(["rbacError"]);
  });

  it("claims senderError by the /Error$/ convention", () => {
    const result = classifyFlashParams(
      paramsOf({ senderError: "No global send-from address is configured yet." }),
      NEUTRAL_PATHNAME,
    );
    expect(result.toasts).toEqual([
      { tone: "error", message: "No global send-from address is configured yet." },
    ]);
    expect(result.stripParams).toEqual(["senderError"]);
  });

  it("claims certError by the /Error$/ convention", () => {
    const result = classifyFlashParams(paramsOf({ certError: "Choose a PDF file." }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "error", message: "Choose a PDF file." }]);
    expect(result.stripParams).toEqual(["certError"]);
  });

  it("claims lastError by the /Error$/ convention too, even though it is never registered", () => {
    // lastError is a TeamsMessage/EmailLog database column, never a real URL param (see the
    // module doc comment). Nothing in this module special-cases it -- it is not in the error
    // code table and has no registry entry -- so if it ever did appear on a URL by accident, the
    // generic /Error$/ convention would still claim its raw value as the message, same as any
    // other suffixed-error param. This pins that (harmless, since it never actually happens)
    // behavior so nobody "fixes" it by adding a registration that isn't wanted.
    const result = classifyFlashParams(paramsOf({ lastError: "SMTP timeout" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "error", message: "SMTP timeout" }]);
    expect(result.stripParams).toEqual(["lastError"]);
  });

  it("claims message alongside error, as its validation detail payload", () => {
    const result = classifyFlashParams(
      paramsOf({ error: "validation", message: "Pick a department first." }),
      NEUTRAL_PATHNAME,
    );
    expect(result.toasts).toEqual([{ tone: "error", message: "Pick a department first." }]);
    expect(result.stripParams.sort()).toEqual(["error", "message"]);
  });

  it("does not claim message when error is absent and the value is not a registered literal", () => {
    const result = classifyFlashParams(paramsOf({ message: "orphaned detail text" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("resolves error=validation with no message to the shared code table's text", () => {
    const result = classifyFlashParams(paramsOf({ error: "validation" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([
      { tone: "error", message: "Please check your input and try again." },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("resolves error=forbidden with no message to the shared code table's text", () => {
    const result = classifyFlashParams(paramsOf({ error: "forbidden" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([
      { tone: "error", message: "You do not have permission for that action." },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("treats an error value that matches no known code as the message itself", () => {
    // The 85-site convention: an arbitrary human-readable string is not in the (deliberately
    // small) code table, so it passes through unchanged rather than being replaced by a generic
    // fallback. This is what keeps a real message like this one from being corrupted.
    const result = classifyFlashParams(
      paramsOf({ error: "netId already belongs to another person" }),
      NEUTRAL_PATHNAME,
    );
    expect(result.toasts).toEqual([
      { tone: "error", message: "netId already belongs to another person" },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("does not claim status, a validated filter on five pages", () => {
    const result = classifyFlashParams(paramsOf({ status: "FAILED" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim page, a pagination cursor", () => {
    const result = classifyFlashParams(paramsOf({ page: "3" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim q, a search filter", () => {
    const result = classifyFlashParams(paramsOf({ q: "smith" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim tab, a view selector", () => {
    const result = classifyFlashParams(paramsOf({ tab: "overview" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim token, a magic-link credential", () => {
    const result = classifyFlashParams(paramsOf({ token: "abc123" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim view, a display mode", () => {
    const result = classifyFlashParams(paramsOf({ view: "grid" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim mode, a display mode", () => {
    const result = classifyFlashParams(paramsOf({ mode: "compact" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim date, a calendar filter", () => {
    const result = classifyFlashParams(paramsOf({ date: "2026-07-30" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim dept, a department filter", () => {
    const result = classifyFlashParams(paramsOf({ dept: "clinical" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim term, a term filter", () => {
    const result = classifyFlashParams(paramsOf({ term: "SU26" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim track, a track filter", () => {
    const result = classifyFlashParams(paramsOf({ track: "DIRECTOR" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim next, a post-login redirect target", () => {
    const result = classifyFlashParams(paramsOf({ next: "/dashboard" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim callbackUrl, an auth redirect target", () => {
    const result = classifyFlashParams(paramsOf({ callbackUrl: "/apply/clinical" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim type, a notification-type filter", () => {
    const result = classifyFlashParams(paramsOf({ type: "SHIFT_REMINDER" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim priority, an incident filter", () => {
    const result = classifyFlashParams(paramsOf({ priority: "high" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim category, an incident filter", () => {
    const result = classifyFlashParams(paramsOf({ category: "safety" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim assignee, an incident filter", () => {
    const result = classifyFlashParams(paramsOf({ assignee: "abc123" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim departmentId, a department filter", () => {
    const result = classifyFlashParams(paramsOf({ departmentId: "clinical" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("claims only the flash param when a flash and a filter share a URL", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1", status: "FAILED" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=1, success tone, with the registry's message", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims sent and skipped together as one toast and strips both", () => {
    const result = classifyFlashParams(paramsOf({ sent: "4", skipped: "2" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([
      {
        tone: "success",
        message: "Released 4 acceptance email(s); skipped 2 conflicted applicant(s).",
      },
    ]);
    expect(result.stripParams.sort()).toEqual(["sent", "skipped"]);
  });

  it("does not claim a bare sent without its skipped partner off the campaigns page", () => {
    // admin/email/campaigns/[id]/page.tsx sets `sent` alone, meaning something else entirely
    // ("Campaign sent to N recipients"); only the decisions page pairs it with `skipped`. Off the
    // campaigns page, the pathname-scoped lone-`sent` entry does not apply either, so this stays
    // fully unclaimed -- proving the registry does not fall back to guessing.
    const result = classifyFlashParams(paramsOf({ sent: "12" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim an unknown param", () => {
    const result = classifyFlashParams(paramsOf({ foo: "bar" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Pathname scoping (Task 2b): a scoped entry wins where it matches; the
  // group's unscoped entry is still the default everywhere else.
  // ---------------------------------------------------------------------------

  it("a scoped saved entry wins over the unscoped default on its own pathname", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/schedule");
    expect(result.toasts).toEqual([{ tone: "success", message: "Availability saved successfully." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("the unscoped saved entry still applies on a pathname with no scoped override", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/admin/settings");
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  // ---------------------------------------------------------------------------
  // Gap 1: schedule/page.tsx's message=reminded / message=already_reminded,
  // which arrive with no `error` present and would otherwise silently vanish.
  // ---------------------------------------------------------------------------

  it("claims message=reminded on the schedule page", () => {
    const result = classifyFlashParams(paramsOf({ message: "reminded" }), "/schedule");
    expect(result.toasts).toEqual([
      { tone: "success", message: "Reminder sent to your department directors." },
    ]);
    expect(result.stripParams).toEqual(["message"]);
  });

  it("claims message=already_reminded on the schedule page, info tone", () => {
    const result = classifyFlashParams(paramsOf({ message: "already_reminded" }), "/schedule");
    expect(result.toasts).toEqual([
      {
        tone: "info",
        message: "Your department directors were already reminded recently, so no new email was sent.",
      },
    ]);
    expect(result.stripParams).toEqual(["message"]);
  });

  it("does not claim message=reminded off the schedule page", () => {
    const result = classifyFlashParams(paramsOf({ message: "reminded" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Gap 2: err / msg on the onboarding and training pages, firing as two
  // independent toasts, not one composed group.
  // ---------------------------------------------------------------------------

  it("claims err on the onboarding page, error tone, raw value", () => {
    const result = classifyFlashParams(
      paramsOf({ err: "3 could not be sent." }),
      "/recruitment/cycles/abc123/onboarding",
    );
    expect(result.toasts).toEqual([{ tone: "error", message: "3 could not be sent." }]);
    expect(result.stripParams).toEqual(["err"]);
  });

  it("claims msg on the onboarding page, success tone, raw value", () => {
    const result = classifyFlashParams(
      paramsOf({ msg: "Sent 5 onboarding link(s)." }),
      "/recruitment/cycles/abc123/onboarding",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Sent 5 onboarding link(s)." }]);
    expect(result.stripParams).toEqual(["msg"]);
  });

  it("claims err and msg together as two independent toasts, not one composed group", () => {
    const result = classifyFlashParams(
      paramsOf({ err: "2 could not be sent.", msg: "Sent 4 onboarding link(s)." }),
      "/recruitment/cycles/abc123/onboarding",
    );
    expect(result.toasts).toEqual([
      { tone: "error", message: "2 could not be sent." },
      { tone: "success", message: "Sent 4 onboarding link(s)." },
    ]);
    expect(result.stripParams.sort()).toEqual(["err", "msg"]);
  });

  it("claims err on the training page too", () => {
    const result = classifyFlashParams(
      paramsOf({ err: "Could not record attendance." }),
      "/recruitment/cycles/abc123/training",
    );
    expect(result.toasts).toEqual([{ tone: "error", message: "Could not record attendance." }]);
    expect(result.stripParams).toEqual(["err"]);
  });

  it("does not claim err off the onboarding and training pages", () => {
    const result = classifyFlashParams(paramsOf({ err: "Some error" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not claim msg off the onboarding and training pages", () => {
    const result = classifyFlashParams(paramsOf({ msg: "Some message" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Gap 3: sent on the waitlist page (paired with promoted) and on the
  // campaign page (standalone) -- three different meanings for one param name.
  // ---------------------------------------------------------------------------

  it("claims promoted+sent on the waitlist page, success tone, emailed", () => {
    const result = classifyFlashParams(
      paramsOf({ promoted: "Jane Doe", sent: "1" }),
      "/recruitment/cycles/abc123/waitlist",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Promoted Jane Doe to accepted and emailed them." }]);
    expect(result.stripParams.sort()).toEqual(["promoted", "sent"]);
  });

  it("claims promoted+sent on the waitlist page, success tone, not emailed", () => {
    const result = classifyFlashParams(
      paramsOf({ promoted: "Jane Doe", sent: "already_emailed" }),
      "/recruitment/cycles/abc123/waitlist",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Promoted Jane Doe to accepted." }]);
    expect(result.stripParams.sort()).toEqual(["promoted", "sent"]);
  });

  it("claims promoted+sent on the waitlist page, warning tone, conflicted", () => {
    const result = classifyFlashParams(
      paramsOf({ promoted: "Jane Doe", sent: "conflicted" }),
      "/recruitment/cycles/abc123/waitlist",
    );
    expect(result.toasts).toEqual([
      {
        tone: "warning",
        message:
          "Promoted Jane Doe to accepted, but they now hold offers from more than one department. Resolve the conflict on the Decisions page, then release to email them.",
      },
    ]);
    expect(result.stripParams.sort()).toEqual(["promoted", "sent"]);
  });

  it("does not claim promoted+sent off the waitlist page", () => {
    const result = classifyFlashParams(paramsOf({ promoted: "Jane Doe", sent: "1" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("claims a lone sent on the campaigns page, singular recipient", () => {
    const result = classifyFlashParams(paramsOf({ sent: "1" }), "/admin/email/campaigns/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Campaign sent to 1 recipient." }]);
    expect(result.stripParams).toEqual(["sent"]);
  });

  it("claims a lone sent on the campaigns page, plural recipients", () => {
    const result = classifyFlashParams(paramsOf({ sent: "12" }), "/admin/email/campaigns/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Campaign sent to 12 recipients." }]);
    expect(result.stripParams).toEqual(["sent"]);
  });

  it("prefers the sent+skipped group over the campaigns page's lone-sent entry when both params are present", () => {
    // Registration order + pathname scoping both guard this: sent+skipped is declared first and
    // is unscoped, so it claims `sent` before the campaigns-scoped lone entry ever gets a look,
    // even if this (synthetic) URL happened to carry the campaigns pathname.
    const result = classifyFlashParams(
      paramsOf({ sent: "4", skipped: "2" }),
      "/admin/email/campaigns/xyz789",
    );
    expect(result.toasts).toEqual([
      {
        tone: "success",
        message: "Released 4 acceptance email(s); skipped 2 conflicted applicant(s).",
      },
    ]);
    expect(result.stripParams.sort()).toEqual(["sent", "skipped"]);
  });

  // ---------------------------------------------------------------------------
  // Suppression: precise (pathname, param) pairs from the inventory's INLINE
  // rulings. A suppressed pair fires no toast and strips nothing, so the
  // page's own inline Alert stays the only thing the user sees. The same
  // param on a pathname that is NOT suppressed must still work normally --
  // the failure mode to guard against is an over-broad suppression quietly
  // swallowing real feedback elsewhere in the app.
  // ---------------------------------------------------------------------------

  it("suppresses error on the login page, ruled INLINE for NextAuth's own vocabulary", () => {
    const result = classifyFlashParams(paramsOf({ error: "CredentialsSignin" }), "/login");
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not suppress error on a page that is not login", () => {
    const result = classifyFlashParams(paramsOf({ error: "CredentialsSignin" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "error", message: "CredentialsSignin" }]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("suppresses error and message together on incidents/page.tsx, ruled INLINE for mixed vocabulary", () => {
    const result = classifyFlashParams(
      paramsOf({ error: "subject-not-found" }),
      "/incidents",
    );
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("leaves message alone too when error is suppressed, since it rides along with error", () => {
    const result = classifyFlashParams(
      paramsOf({ error: "validation", message: "Pick a department first." }),
      "/incidents",
    );
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("suppresses error on incidents/strikes/page.tsx even for a code that IS in the shared table", () => {
    // This is the case that matters most: `not-found` has a correctly-scoped, correctly-worded
    // entry for this exact pathname in the shared code table (see below), and suppression must
    // still win outright -- a page ruled INLINE keeps its inline Alert as the ONLY renderer for
    // its error param, never a toast alongside it, regardless of whether the toast's text would
    // have been right.
    const result = classifyFlashParams(paramsOf({ error: "not-found" }), "/incidents/strikes");
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("suppresses error on incidents/strikes/page.tsx for its own page-owned codes too", () => {
    const result = classifyFlashParams(paramsOf({ error: "bad-category" }), "/incidents/strikes");
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not suppress error on incidents/[id]/page.tsx, ruled TOAST (SHARED CODES)", () => {
    const result = classifyFlashParams(paramsOf({ error: "forbidden" }), "/incidents/abc123");
    expect(result.toasts).toEqual([
      { tone: "error", message: "You do not have permission for that action." },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  // ---------------------------------------------------------------------------
  // The not-found conflict, and the pathname matcher fix that makes it
  // registerable: a static segment (a known sibling route) beats a wildcard.
  // ---------------------------------------------------------------------------

  it("resolves error=not-found on incidents/[id]/page.tsx to its own text", () => {
    const result = classifyFlashParams(paramsOf({ error: "not-found" }), "/incidents/abc123");
    expect(result.toasts).toEqual([
      { tone: "error", message: "The incident report could not be found." },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("does not leak incidents/[id]'s not-found text onto the sibling static route /incidents/review", () => {
    // /incidents/review is NOT suppressed (only /incidents, /incidents/strikes, and /login are),
    // so this specifically proves the `except` exclusion on the /incidents/* wildcard works, not
    // just that suppression happens to also cover this case. With no scoped match and no unscoped
    // default for "not-found", the value falls through to "the value IS the message" -- the raw
    // code, not a wrongly-borrowed sentence from a different page.
    const result = classifyFlashParams(paramsOf({ error: "not-found" }), "/incidents/review");
    expect(result.toasts).toEqual([{ tone: "error", message: "not-found" }]);
    expect(result.stripParams).toEqual(["error"]);
  });
});
