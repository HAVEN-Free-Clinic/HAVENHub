/**
 * Tests for Epic email templates.
 *
 * Pure unit tests -- no DB, no network.
 */

import { describe, expect, it } from "vitest";
import {
  epicOnboardingEmail,
  epicActivationEmail,
  epicPasswordResetEmail,
  EPIC_TEMPLATES,
  type EpicEmailParams,
} from "./epic";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function baseline(overrides?: Partial<EpicEmailParams>): EpicEmailParams {
  return {
    personName: "Alice Smith",
    netId: "as123",
    contactEmail: "alice@yale.edu",
    epicId: "ASMITH",
    departmentNames: ["Outreach", "Triage"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EPIC_TEMPLATES map
// ---------------------------------------------------------------------------

describe("EPIC_TEMPLATES", () => {
  it("has exactly the three expected keys", () => {
    expect(Object.keys(EPIC_TEMPLATES).sort()).toEqual([
      "epic-activation",
      "epic-onboarding",
      "epic-password-reset",
    ]);
  });

  it("maps epic-onboarding to epicOnboardingEmail", () => {
    expect(EPIC_TEMPLATES["epic-onboarding"]).toBe(epicOnboardingEmail);
  });

  it("maps epic-activation to epicActivationEmail", () => {
    expect(EPIC_TEMPLATES["epic-activation"]).toBe(epicActivationEmail);
  });

  it("maps epic-password-reset to epicPasswordResetEmail", () => {
    expect(EPIC_TEMPLATES["epic-password-reset"]).toBe(epicPasswordResetEmail);
  });
});

// ---------------------------------------------------------------------------
// epicOnboardingEmail
// ---------------------------------------------------------------------------

describe("epicOnboardingEmail", () => {
  it("returns non-empty subject and html", () => {
    const { subject, html } = epicOnboardingEmail(baseline());
    expect(subject).toBeTruthy();
    expect(html).toBeTruthy();
  });

  it("html contains the person name", () => {
    const { html } = epicOnboardingEmail(baseline());
    expect(html).toContain("Alice Smith");
  });

  // -- kind=RENEW (default when kind is missing) --

  it("RENEW subject contains 'Renewal' and person name", () => {
    const { subject } = epicOnboardingEmail(baseline({ kind: "RENEW" }));
    expect(subject).toBe("[HAVEN] Epic Renewal for Alice Smith");
  });

  it("RENEW first sentence mentions renewing the account", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "RENEW" }));
    expect(html).toContain("renew your Epic account");
  });

  it("RENEW includes the returning-director permissions sentence", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "RENEW" }));
    expect(html).toContain("permissions within Epic will not change");
  });

  it("RENEW includes the no-retraining sentence", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "RENEW" }));
    expect(html).toContain("will not be required to re-complete Epic training");
  });

  it("RENEW says 'Your Epic ID being renewed is'", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "RENEW" }));
    expect(html).toContain("Your Epic ID being renewed is");
    expect(html).toContain("ASMITH");
  });

  it("default kind (undefined) behaves like RENEW", () => {
    const withRenew = epicOnboardingEmail(baseline({ kind: "RENEW" }));
    const withUndefined = epicOnboardingEmail(baseline({ kind: undefined }));
    expect(withUndefined.subject).toBe(withRenew.subject);
    expect(withUndefined.html).toBe(withRenew.html);
  });

  // -- kind=NEW --

  it("NEW subject contains 'Account Request'", () => {
    const { subject } = epicOnboardingEmail(baseline({ kind: "NEW" }));
    expect(subject).toBe("[HAVEN] Epic Account Request for Alice Smith");
  });

  it("NEW first sentence mentions creating the account", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "NEW" }));
    expect(html).toContain("create your new Epic account");
  });

  it("NEW does NOT include the returning-director permissions sentence", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "NEW" }));
    expect(html).not.toContain("permissions within Epic will not change");
  });

  it("NEW does NOT include the no-retraining sentence", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "NEW" }));
    expect(html).not.toContain("will not be required to re-complete Epic training");
  });

  // -- kind=MODIFY --

  it("MODIFY subject contains 'Account Modification'", () => {
    const { subject } = epicOnboardingEmail(baseline({ kind: "MODIFY" }));
    expect(subject).toBe("[HAVEN] Epic Account Modification for Alice Smith");
  });

  it("MODIFY first sentence mentions modifying the account", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "MODIFY" }));
    expect(html).toContain("modify your Epic account");
  });

  it("MODIFY does NOT include the returning-director permissions sentence", () => {
    const { html } = epicOnboardingEmail(baseline({ kind: "MODIFY" }));
    expect(html).not.toContain("permissions within Epic will not change");
  });

  // -- detail lines --

  it("renders contactEmail detail line", () => {
    const { html } = epicOnboardingEmail(baseline());
    expect(html).toContain("alice@yale.edu");
  });

  it("renders netId detail line", () => {
    const { html } = epicOnboardingEmail(baseline());
    expect(html).toContain("as123");
  });

  it("renders departmentNames joined with comma", () => {
    const { html } = epicOnboardingEmail(baseline());
    expect(html).toContain("Outreach, Triage");
  });

  it("omits contactEmail line when missing", () => {
    const { html } = epicOnboardingEmail(baseline({ contactEmail: null }));
    expect(html).not.toContain("alice@yale.edu");
    expect(html).not.toContain("Your email:");
  });

  it("omits netId line when missing", () => {
    const { html } = epicOnboardingEmail(baseline({ netId: null }));
    expect(html).not.toContain("as123");
    expect(html).not.toContain("Your Net ID:");
  });

  it("omits department line when departmentNames empty", () => {
    const { html } = epicOnboardingEmail(baseline({ departmentNames: [] }));
    expect(html).not.toContain("Department:");
  });

  it("uses 'pending assignment' fallback when epicId is null", () => {
    const { html } = epicOnboardingEmail(baseline({ epicId: null }));
    expect(html).toContain("pending assignment");
  });

  // -- escaping --

  it("HTML-escapes a malicious personName", () => {
    const { html } = epicOnboardingEmail(baseline({ personName: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes a malicious epicId", () => {
    const { html } = epicOnboardingEmail(baseline({ epicId: '<img src="x">' }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

// ---------------------------------------------------------------------------
// epicActivationEmail
// ---------------------------------------------------------------------------

describe("epicActivationEmail", () => {
  it("returns non-empty subject and html", () => {
    const { subject, html } = epicActivationEmail(baseline());
    expect(subject).toBeTruthy();
    expect(html).toBeTruthy();
  });

  it("subject is exactly '[HAVEN] New Epic Account Set-up'", () => {
    const { subject } = epicActivationEmail(baseline());
    expect(subject).toBe("[HAVEN] New Epic Account Set-up");
  });

  it("html contains the person name", () => {
    const { html } = epicActivationEmail(baseline());
    expect(html).toContain("Alice Smith");
  });

  it("renders epicId when present", () => {
    const { html } = epicActivationEmail(baseline({ epicId: "ASMITH" }));
    expect(html).toContain("ASMITH");
  });

  it("uses 'pending assignment' fallback when epicId is null", () => {
    const { html } = epicActivationEmail(baseline({ epicId: null }));
    expect(html).toContain("pending assignment");
  });

  it("html contains key activation instructions", () => {
    const { html } = epicActivationEmail(baseline());
    expect(html).toContain("48 hours");
    expect(html).toContain("203-688-4357");
    expect(html).toContain("YM HAVEN FREE CLINIC");
  });

  it("HTML-escapes a malicious personName", () => {
    const { html } = epicActivationEmail(baseline({ personName: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// epicPasswordResetEmail
// ---------------------------------------------------------------------------

describe("epicPasswordResetEmail", () => {
  it("returns non-empty subject and html", () => {
    const { subject, html } = epicPasswordResetEmail(baseline());
    expect(subject).toBeTruthy();
    expect(html).toBeTruthy();
  });

  it("subject is exactly '[HAVEN] Epic Account Reset'", () => {
    const { subject } = epicPasswordResetEmail(baseline());
    expect(subject).toBe("[HAVEN] Epic Account Reset");
  });

  it("html contains the person name", () => {
    const { html } = epicPasswordResetEmail(baseline());
    expect(html).toContain("Alice Smith");
  });

  it("renders epicId when present", () => {
    const { html } = epicPasswordResetEmail(baseline({ epicId: "ASMITH" }));
    expect(html).toContain("ASMITH");
  });

  it("uses 'pending assignment' fallback when epicId is null", () => {
    const { html } = epicPasswordResetEmail(baseline({ epicId: null }));
    expect(html).toContain("pending assignment");
  });

  it("html mentions the temporary password", () => {
    const { html } = epicPasswordResetEmail(baseline());
    expect(html).toContain("SecureCare4u#25");
  });

  it("html contains key access instructions", () => {
    const { html } = epicPasswordResetEmail(baseline());
    expect(html).toContain("48 hours");
    expect(html).toContain("203-688-4357");
    expect(html).toContain("YM HAVEN FREE CLINIC");
  });

  it("HTML-escapes a malicious personName", () => {
    const { html } = epicPasswordResetEmail(baseline({ personName: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
