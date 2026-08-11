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

  it("does not let message ride along with a suffixed *Error param, only with bare error", () => {
    // The module doc states this explicitly ("never pairs with a suffixed `*Error`
    // param"). Unreachable today because no redirect emits the pair, but a mutation
    // that widened the pairing to any error-convention param survived the suite, so
    // pin it: rosterError must carry its own value and leave message untouched.
    const result = classifyFlashParams(
      paramsOf({ rosterError: "Row 4 is malformed.", message: "should not be consumed" }),
      NEUTRAL_PATHNAME,
    );
    expect(result.toasts).toEqual([{ tone: "error", message: "Row 4 is malformed." }]);
    expect(result.stripParams).toEqual(["rosterError"]);
  });

  it("matches the error suffix at the end only, so a param merely containing Error is untouched", () => {
    // /Error$/ is deliberately anchored. A mutation to name.includes("Error") survived
    // the suite, and the permissive direction is the dangerous one: it would claim and
    // strip any future filter whose name happens to contain the substring.
    const result = classifyFlashParams(
      paramsOf({ ErrorLog: "x", errorsOnly: "1", showErrorDetail: "yes" }),
      NEUTRAL_PATHNAME,
    );
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

  it("suppresses error on incidents/strikes/page.tsx even for a code the shared table also knows", () => {
    // This is the case that matters most: `not-found` has a scoped, correctly-worded entry for
    // /incidents/review in the shared code table (see below), and incidents/strikes is deliberately
    // excluded from that entry's wildcard too -- but suppression is what actually matters here: a
    // page ruled INLINE keeps its inline Alert as the ONLY renderer for its error param, never a
    // toast alongside it, regardless of what the code table would or would not have resolved.
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

  it("resolves error=not-found on /incidents/review to the same text, since that is where it actually lands", () => {
    // Every live `?error=not-found` redirect goes to /incidents/review or /incidents/strikes,
    // never to /incidents/[id] -- incidents/actions.ts's own comment says a missing report
    // "bounces to the review queue instead", so /incidents/review is deliberately INCLUDED under
    // the /incidents/* wildcard, not excluded. Before this fix the entry excluded this pathname
    // and the one real destination got a raw "not-found" slug instead of real text.
    const result = classifyFlashParams(paramsOf({ error: "not-found" }), "/incidents/review");
    expect(result.toasts).toEqual([
      { tone: "error", message: "The incident report could not be found." },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("does not leak the not-found text onto /incidents/mine, a sibling the except list still excludes", () => {
    // /incidents/mine is NOT suppressed (only /incidents, /incidents/strikes, and /login are) and
    // never actually receives this code, so this specifically proves the `except` exclusion on the
    // /incidents/* wildcard still works for a real sibling, not just that suppression happens to
    // also cover the case. With no scoped match and no unscoped default for "not-found", the value
    // falls through to "the value IS the message" -- the raw code, not a borrowed sentence.
    const result = classifyFlashParams(paramsOf({ error: "not-found" }), "/incidents/mine");
    expect(result.toasts).toEqual([{ tone: "error", message: "not-found" }]);
    expect(result.stripParams).toEqual(["error"]);
  });

  // ---------------------------------------------------------------------------
  // /apply's one slug code: the public, unauthenticated first-touch surface.
  // apply/verify/page.tsx:44 redirects to /apply?error=link. /apply inline-renders
  // ONLY error=signin (its own Alert, unrelated to this code); error=link has no
  // inline renderer there, so it must keep resolving through this table to a
  // toast. Before this entry existed, the toast read "link".
  // ---------------------------------------------------------------------------

  it("resolves error=link on /apply to its real text", () => {
    const result = classifyFlashParams(paramsOf({ error: "link" }), "/apply");
    expect(result.toasts).toEqual([
      {
        tone: "error",
        message: "That link has expired or was already used. Request a new one below.",
      },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("does not resolve error=link off the /apply pathname", () => {
    // "link" is /apply's own vocabulary; off that pathname it is just an unrecognized code, so the
    // value IS the message, per the 85-site convention.
    const result = classifyFlashParams(paramsOf({ error: "link" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "error", message: "link" }]);
    expect(result.stripParams).toEqual(["error"]);
  });

  // ---------------------------------------------------------------------------
  // The segment-count guard: `*` matches exactly one path segment, not a
  // prefix. Every other scoping test above uses a pathname the same depth as
  // its pattern; this one is deliberately deeper.
  // ---------------------------------------------------------------------------

  it("does not let the /schedule scope match a deeper real route like /schedule/requests", () => {
    // If `*` (or a missing segment-count check) ever matched a prefix instead of exactly one
    // segment, /schedule/requests and /schedule/builder would both incorrectly pick up the
    // /schedule-scoped "Availability saved successfully." text meant only for /schedule itself.
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/schedule/requests");
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("does not let the /schedule scope match a deeper real route like /schedule/builder", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/schedule/builder");
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  // ---------------------------------------------------------------------------
  // Empty values are treated as absent, not as a real (blank) flash.
  // ---------------------------------------------------------------------------

  it("does not toast an empty error value", () => {
    const result = classifyFlashParams(paramsOf({ error: "" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("does not let an empty message beat the code table's real text for validation", () => {
    // Previously: params.get("message") returned "", which is non-null, so the (empty) detail won
    // over resolveErrorValue and both params were stripped while showing nothing.
    const result = classifyFlashParams(
      paramsOf({ error: "validation", message: "" }),
      NEUTRAL_PATHNAME,
    );
    expect(result.toasts).toEqual([
      { tone: "error", message: "Please check your input and try again." },
    ]);
    expect(result.stripParams).toEqual(["error"]);
  });

  it("does not fire a registry entry for an empty saved value", () => {
    const result = classifyFlashParams(paramsOf({ saved: "" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // The pathname is normalized once, so a trailing slash cannot defeat scoping
  // or suppression (matters most for suppression: failing open there is a
  // spec violation, not a cosmetic miss).
  // ---------------------------------------------------------------------------

  it("still suppresses error on /login/ with a trailing slash", () => {
    const result = classifyFlashParams(paramsOf({ error: "CredentialsSignin" }), "/login/");
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("still resolves the /schedule scope for saved with a trailing slash", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/schedule/");
    expect(result.toasts).toEqual([{ tone: "success", message: "Availability saved successfully." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: the success-family pages. saved=<value> literal-value groups on the
  // applicants and interviews detail pages -- these must be declared before the
  // plain `saved` group (see the registry's own doc comment), so every one of
  // these also proves that ordering: a wrong order would show "Saved." instead.
  // ---------------------------------------------------------------------------

  it("claims saved=decision on the applicants detail page", () => {
    const result = classifyFlashParams(
      paramsOf({ saved: "decision" }),
      "/recruitment/cycles/abc123/applicants/xyz789",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Decision recorded." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=decision on the interviews detail page too", () => {
    const result = classifyFlashParams(
      paramsOf({ saved: "decision" }),
      "/recruitment/interviews/xyz789",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Decision recorded." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("falls through to the generic Saved. text for saved=decision off either detail page", () => {
    // Unlike `message` (which has no unscoped fallback at all), `saved` does: a
    // literal-value group that does not match this pathname simply does not fire,
    // and the plain, value-agnostic `saved` group below it has no `matchValues`
    // restriction, so it claims `saved` regardless of its value. This mirrors the
    // pre-migration behavior exactly -- the original inline checks were all bare
    // truthiness (`{saved && ...}`), not a `=== "decision"` comparison.
    const result = classifyFlashParams(paramsOf({ saved: "decision" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=reopened on the applicants detail page only", () => {
    const result = classifyFlashParams(
      paramsOf({ saved: "reopened" }),
      "/recruitment/cycles/abc123/applicants/xyz789",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Decision reopened." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("falls through to the generic Saved. text for saved=reopened on the interviews detail page", () => {
    // Confirms the applicants-only scope doesn't leak onto interviews just because
    // both pages share the "decision"/"rescind" values -- and, same as above, the
    // plain `saved` group is still the fallback once the reopened-specific one
    // declines to fire here.
    const result = classifyFlashParams(paramsOf({ saved: "reopened" }), "/recruitment/interviews/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=rescind on the applicants detail page", () => {
    const result = classifyFlashParams(
      paramsOf({ saved: "rescind" }),
      "/recruitment/cycles/abc123/applicants/xyz789",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Acceptance rescinded." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=rescind on the interviews detail page too", () => {
    const result = classifyFlashParams(paramsOf({ saved: "rescind" }), "/recruitment/interviews/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Acceptance rescinded." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=schedule on the interviews detail page only", () => {
    const result = classifyFlashParams(paramsOf({ saved: "schedule" }), "/recruitment/interviews/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Schedule saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=panelist on the interviews detail page only", () => {
    const result = classifyFlashParams(paramsOf({ saved: "panelist" }), "/recruitment/interviews/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Panel updated." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=invite on the interviews detail page only", () => {
    const result = classifyFlashParams(paramsOf({ saved: "invite" }), "/recruitment/interviews/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Invite sent." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=evaluation on the interviews detail page only", () => {
    const result = classifyFlashParams(paramsOf({ saved: "evaluation" }), "/recruitment/interviews/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Evaluation saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: more scoped siblings of the plain `saved` group. "saved" does not
  // mean one thing -- see the page inventory's finding 1.
  // ---------------------------------------------------------------------------

  it("claims saved=1 on a department edit page as Changes saved.", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/admin/departments/abc123");
    expect(result.toasts).toEqual([{ tone: "success", message: "Changes saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=1 on a subcommittee edit page as Changes saved. too", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/admin/subcommittees/abc123");
    expect(result.toasts).toEqual([{ tone: "success", message: "Changes saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=1 on the cycle subcommittee assignment page as Assignment saved.", () => {
    const result = classifyFlashParams(
      paramsOf({ saved: "1" }),
      "/recruitment/cycles/abc123/subcommittees",
    );
    expect(result.toasts).toEqual([{ tone: "success", message: "Assignment saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  it("claims saved=1 on the campaign editor as Campaign saved.", () => {
    const result = classifyFlashParams(paramsOf({ saved: "1" }), "/admin/email/campaigns/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Campaign saved." }]);
    expect(result.stripParams).toEqual(["saved"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: the campaign editor's other flags (tested, preview+count+excluded,
  // scheduled, cancelled). All scoped to the campaigns pathname.
  // ---------------------------------------------------------------------------

  it("claims tested=1 on the campaign editor", () => {
    const result = classifyFlashParams(paramsOf({ tested: "1" }), "/admin/email/campaigns/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Test email sent to your address." }]);
    expect(result.stripParams).toEqual(["tested"]);
  });

  it("claims preview+count+excluded, plural recipients, no exclusions", () => {
    const result = classifyFlashParams(
      paramsOf({ preview: "1", count: "5", excluded: "0" }),
      "/admin/email/campaigns/xyz789",
    );
    expect(result.toasts).toEqual([
      { tone: "info", message: "Audience preview: 5 recipients." },
    ]);
    expect(result.stripParams.sort()).toEqual(["count", "excluded", "preview"]);
  });

  it("claims preview+count+excluded, singular recipient", () => {
    const result = classifyFlashParams(
      paramsOf({ preview: "1", count: "1", excluded: "0" }),
      "/admin/email/campaigns/xyz789",
    );
    expect(result.toasts).toEqual([
      { tone: "info", message: "Audience preview: 1 recipient." },
    ]);
    expect(result.stripParams.sort()).toEqual(["count", "excluded", "preview"]);
  });

  it("claims preview+count+excluded with exclusions appended", () => {
    const result = classifyFlashParams(
      paramsOf({ preview: "1", count: "5", excluded: "2" }),
      "/admin/email/campaigns/xyz789",
    );
    expect(result.toasts).toEqual([
      {
        tone: "info",
        message: "Audience preview: 5 recipients, 2 excluded (no email address on file).",
      },
    ]);
    expect(result.stripParams.sort()).toEqual(["count", "excluded", "preview"]);
  });

  it("claims scheduled=1 on the campaign editor", () => {
    const result = classifyFlashParams(paramsOf({ scheduled: "1" }), "/admin/email/campaigns/xyz789");
    expect(result.toasts).toEqual([{ tone: "success", message: "Campaign scheduled." }]);
    expect(result.stripParams).toEqual(["scheduled"]);
  });

  it("claims cancelled=1 on the campaign editor, info tone", () => {
    const result = classifyFlashParams(paramsOf({ cancelled: "1" }), "/admin/email/campaigns/xyz789");
    expect(result.toasts).toEqual([{ tone: "info", message: "Schedule cancelled." }]);
    expect(result.stripParams).toEqual(["cancelled"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: /admin/email and /admin/notifications. `retried` means different
  // things on each -- no unscoped default, matching the `sent` disambiguation
  // pattern above.
  // ---------------------------------------------------------------------------

  it("claims retried=1 on /admin/email as Email re-queued.", () => {
    const result = classifyFlashParams(paramsOf({ retried: "1" }), "/admin/email");
    expect(result.toasts).toEqual([{ tone: "success", message: "Email re-queued." }]);
    expect(result.stripParams).toEqual(["retried"]);
  });

  it("claims retried=1 on /admin/notifications as Teams message re-queued.", () => {
    const result = classifyFlashParams(paramsOf({ retried: "1" }), "/admin/notifications");
    expect(result.toasts).toEqual([{ tone: "success", message: "Teams message re-queued." }]);
    expect(result.stripParams).toEqual(["retried"]);
  });

  it("does not claim retried off either admin monitoring page", () => {
    const result = classifyFlashParams(paramsOf({ retried: "1" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  it("claims retriedAll on /admin/email, plural", () => {
    const result = classifyFlashParams(paramsOf({ retriedAll: "3" }), "/admin/email");
    expect(result.toasts).toEqual([{ tone: "success", message: "3 failed emails re-queued." }]);
    expect(result.stripParams).toEqual(["retriedAll"]);
  });

  it("claims retriedAll on /admin/email, singular", () => {
    const result = classifyFlashParams(paramsOf({ retriedAll: "1" }), "/admin/email");
    expect(result.toasts).toEqual([{ tone: "success", message: "1 failed email re-queued." }]);
    expect(result.stripParams).toEqual(["retriedAll"]);
  });

  it("claims connected=1 on /admin/email", () => {
    const result = classifyFlashParams(paramsOf({ connected: "1" }), "/admin/email");
    expect(result.toasts).toEqual([{ tone: "success", message: "Mailbox connected." }]);
    expect(result.stripParams).toEqual(["connected"]);
  });

  it("claims senderSaved=1 on /admin/email", () => {
    const result = classifyFlashParams(paramsOf({ senderSaved: "1" }), "/admin/email");
    expect(result.toasts).toEqual([{ tone: "success", message: "Sender address saved." }]);
    expect(result.stripParams).toEqual(["senderSaved"]);
  });

  it("claims senderTested=1 on /admin/email", () => {
    const result = classifyFlashParams(paramsOf({ senderTested: "1" }), "/admin/email");
    expect(result.toasts).toEqual([
      { tone: "success", message: "Test message sent. Check the inbox to confirm." },
    ]);
    expect(result.stripParams).toEqual(["senderTested"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: /admin/terms/[id]'s roster-copy summary and onboarding-steps flag.
  // ---------------------------------------------------------------------------

  it("claims copied+skipped on a term detail page", () => {
    const result = classifyFlashParams(
      paramsOf({ copied: "4", skipped: "1" }),
      "/admin/terms/abc123",
    );
    expect(result.toasts).toEqual([
      {
        tone: "success",
        message: "Copied 4 membership(s); 1 already existed and were skipped.",
      },
    ]);
    expect(result.stripParams.sort()).toEqual(["copied", "skipped"]);
  });

  it("claims stepsSaved=1 on a term detail page", () => {
    const result = classifyFlashParams(paramsOf({ stepsSaved: "1" }), "/admin/terms/abc123");
    expect(result.toasts).toEqual([{ tone: "success", message: "Onboarding steps saved." }]);
    expect(result.stripParams).toEqual(["stepsSaved"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: certSaved, shared byte-identical text across /my-info and
  // /get-started/hipaa (both render it via the same HipaaPanel component).
  // ---------------------------------------------------------------------------

  it("claims certSaved=1 on /my-info", () => {
    const result = classifyFlashParams(paramsOf({ certSaved: "1" }), "/my-info");
    expect(result.toasts).toEqual([
      { tone: "success", message: "Certificate uploaded successfully." },
    ]);
    expect(result.stripParams).toEqual(["certSaved"]);
  });

  it("claims certSaved=1 on /get-started/hipaa too", () => {
    const result = classifyFlashParams(paramsOf({ certSaved: "1" }), "/get-started/hipaa");
    expect(result.toasts).toEqual([
      { tone: "success", message: "Certificate uploaded successfully." },
    ]);
    expect(result.stripParams).toEqual(["certSaved"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: the cycle overview page's department/window flags.
  // ---------------------------------------------------------------------------

  it("claims deptsaved=1 on a cycle overview page", () => {
    const result = classifyFlashParams(paramsOf({ deptsaved: "1" }), "/recruitment/cycles/abc123");
    expect(result.toasts).toEqual([{ tone: "success", message: "Departments updated." }]);
    expect(result.stripParams).toEqual(["deptsaved"]);
  });

  it("claims deptwarn with the removed department codes interpolated in, warning tone", () => {
    const result = classifyFlashParams(
      paramsOf({ deptwarn: "SCTS, PCAR" }),
      "/recruitment/cycles/abc123",
    );
    expect(result.toasts).toEqual([
      {
        tone: "warning",
        message:
          "Saved. These removed departments still have applicants: SCTS, PCAR. Existing applications keep their choices, but you can no longer accept into a removed department.",
      },
    ]);
    expect(result.stripParams).toEqual(["deptwarn"]);
  });

  it("claims windowsaved=1 on a cycle overview page", () => {
    const result = classifyFlashParams(paramsOf({ windowsaved: "1" }), "/recruitment/cycles/abc123");
    expect(result.toasts).toEqual([{ tone: "success", message: "Application window updated." }]);
    expect(result.stripParams).toEqual(["windowsaved"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: schedule's change-request flag.
  // ---------------------------------------------------------------------------

  it("claims requested=1 on /schedule", () => {
    const result = classifyFlashParams(paramsOf({ requested: "1" }), "/schedule");
    expect(result.toasts).toEqual([
      { tone: "success", message: "Change request submitted. Your director will review it." },
    ]);
    expect(result.stripParams).toEqual(["requested"]);
  });

  // ---------------------------------------------------------------------------
  // Task 6: `submitted` means different things on /incidents/mine and
  // /support/[id] -- no unscoped default, same disambiguation shape as `retried`.
  // ---------------------------------------------------------------------------

  it("claims submitted on /incidents/mine with the report number interpolated in", () => {
    const result = classifyFlashParams(paramsOf({ submitted: "42" }), "/incidents/mine");
    expect(result.toasts).toEqual([{ tone: "success", message: "Report #42 submitted." }]);
    expect(result.stripParams).toEqual(["submitted"]);
  });

  it("claims submitted=1 on a support ticket page", () => {
    const result = classifyFlashParams(paramsOf({ submitted: "1" }), "/support/abc123");
    expect(result.toasts).toEqual([
      { tone: "success", message: "Request submitted. We will keep you posted here." },
    ]);
    expect(result.stripParams).toEqual(["submitted"]);
  });

  it("does not claim submitted off /incidents/mine or /support/*", () => {
    const result = classifyFlashParams(paramsOf({ submitted: "1" }), NEUTRAL_PATHNAME);
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Suppression: /apply renders its own inline <Alert> for error=signin (a
  // failed Yale sign-in), the same reason /login opts out above.
  // ---------------------------------------------------------------------------

  it("suppresses error on /apply, ruled INLINE for the sign-in failure alert", () => {
    const result = classifyFlashParams(paramsOf({ error: "signin" }), "/apply");
    expect(result.toasts).toEqual([]);
    expect(result.stripParams).toEqual([]);
  });
});
