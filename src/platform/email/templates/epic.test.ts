/**
 * Tests for Epic email templates.
 *
 * Behavioral tests covering the context builders and descriptor structure.
 * Byte-exact golden-master tests live in epic.golden.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import {
  epicOnboardingContext,
  epicActivationContext,
  epicPasswordResetContext,
  epicDescriptors,
  type EpicEmailParams,
  type EpicTemplateKey,
} from "./epic";
import { renderEmail } from "./renderEmail";

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

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// epicDescriptors structure
// ---------------------------------------------------------------------------

describe("epicDescriptors", () => {
  it("has exactly the three expected keys", () => {
    expect(epicDescriptors.map((d) => d.key).sort()).toEqual([
      "epic-activation",
      "epic-onboarding",
      "epic-password-reset",
    ]);
  });

  it("all descriptors have category transactional", () => {
    for (const d of epicDescriptors) {
      expect(d.category).toBe("transactional");
    }
  });
});

// ---------------------------------------------------------------------------
// epic-onboarding (via renderEmail)
// ---------------------------------------------------------------------------

describe("epic-onboarding", () => {
  it("returns non-empty subject and html", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline()));
    expect(out.subject).toBeTruthy();
    expect(out.html).toBeTruthy();
  });

  it("html contains the person name", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline()));
    expect(out.html).toContain("Alice Smith");
  });

  // -- kind=RENEW (default when kind is missing) --

  it("RENEW subject contains 'Renewal' and person name", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "RENEW" })));
    expect(out.subject).toBe("[HAVEN] Epic Renewal for Alice Smith");
  });

  it("RENEW first sentence mentions renewing the account", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "RENEW" })));
    expect(out.html).toContain("renew your Epic account");
  });

  it("RENEW includes the returning-director permissions sentence", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "RENEW" })));
    expect(out.html).toContain("permissions within Epic will not change");
  });

  it("RENEW includes the no-retraining sentence", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "RENEW" })));
    expect(out.html).toContain("will not be required to re-complete Epic training");
  });

  it("RENEW says 'Your Epic ID being renewed is'", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "RENEW" })));
    expect(out.html).toContain("Your Epic ID being renewed is");
    expect(out.html).toContain("ASMITH");
  });

  it("default kind (undefined) behaves like RENEW", async () => {
    const withRenew = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "RENEW" })));
    const withUndefined = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: undefined })));
    expect(withUndefined.subject).toBe(withRenew.subject);
    expect(withUndefined.html).toBe(withRenew.html);
  });

  // -- kind=NEW --

  it("NEW subject contains 'Account Request'", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "NEW" })));
    expect(out.subject).toBe("[HAVEN] Epic Account Request for Alice Smith");
  });

  it("NEW first sentence mentions creating the account", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "NEW" })));
    expect(out.html).toContain("create your new Epic account");
  });

  it("NEW does NOT include the returning-director permissions sentence", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "NEW" })));
    expect(out.html).not.toContain("permissions within Epic will not change");
  });

  it("NEW does NOT include the no-retraining sentence", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "NEW" })));
    expect(out.html).not.toContain("will not be required to re-complete Epic training");
  });

  // -- kind=MODIFY --

  it("MODIFY subject contains 'Account Modification'", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "MODIFY" })));
    expect(out.subject).toBe("[HAVEN] Epic Account Modification for Alice Smith");
  });

  it("MODIFY first sentence mentions modifying the account", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "MODIFY" })));
    expect(out.html).toContain("modify your Epic account");
  });

  it("MODIFY does NOT include the returning-director permissions sentence", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ kind: "MODIFY" })));
    expect(out.html).not.toContain("permissions within Epic will not change");
  });

  // -- detail lines --

  it("renders contactEmail detail line", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline()));
    expect(out.html).toContain("alice@yale.edu");
  });

  it("renders netId detail line", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline()));
    expect(out.html).toContain("as123");
  });

  it("renders departmentNames joined with comma", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline()));
    expect(out.html).toContain("Outreach, Triage");
  });

  it("omits contactEmail line when missing", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ contactEmail: null })));
    expect(out.html).not.toContain("alice@yale.edu");
    expect(out.html).not.toContain("Your email:");
  });

  it("omits netId line when missing", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ netId: null })));
    expect(out.html).not.toContain("as123");
    expect(out.html).not.toContain("Your Net ID:");
  });

  it("omits department line when departmentNames empty", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ departmentNames: [] })));
    expect(out.html).not.toContain("Department:");
  });

  it("uses 'pending assignment' fallback when epicId is null", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ epicId: null })));
    expect(out.html).toContain("pending assignment");
  });

  // -- escaping --

  it("HTML-escapes a malicious personName", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ personName: "<script>alert(1)</script>" })));
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes a malicious epicId", async () => {
    const out = await renderEmail("epic-onboarding", epicOnboardingContext(baseline({ epicId: '<img src="x">' })));
    expect(out.html).not.toContain("<img");
    expect(out.html).toContain("&lt;img");
  });
});

// ---------------------------------------------------------------------------
// epic-activation (via renderEmail)
// ---------------------------------------------------------------------------

describe("epic-activation", () => {
  it("returns non-empty subject and html", async () => {
    const out = await renderEmail("epic-activation", epicActivationContext(baseline()));
    expect(out.subject).toBeTruthy();
    expect(out.html).toBeTruthy();
  });

  it("subject is exactly '[HAVEN] New Epic Account Set-up'", async () => {
    const out = await renderEmail("epic-activation", epicActivationContext(baseline()));
    expect(out.subject).toBe("[HAVEN] New Epic Account Set-up");
  });

  it("html contains the person name", async () => {
    const out = await renderEmail("epic-activation", epicActivationContext(baseline()));
    expect(out.html).toContain("Alice Smith");
  });

  it("renders epicId when present", async () => {
    const out = await renderEmail("epic-activation", epicActivationContext(baseline({ epicId: "ASMITH" })));
    expect(out.html).toContain("ASMITH");
  });

  it("uses 'pending assignment' fallback when epicId is null", async () => {
    const out = await renderEmail("epic-activation", epicActivationContext(baseline({ epicId: null })));
    expect(out.html).toContain("pending assignment");
  });

  it("html contains key activation instructions", async () => {
    const out = await renderEmail("epic-activation", epicActivationContext(baseline()));
    expect(out.html).toContain("48 hours");
    expect(out.html).toContain("203-688-4357");
    expect(out.html).toContain("YM HAVEN FREE CLINIC");
  });

  it("HTML-escapes a malicious personName", async () => {
    const out = await renderEmail("epic-activation", epicActivationContext(baseline({ personName: "<script>alert(1)</script>" })));
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// epic-password-reset (via renderEmail)
// ---------------------------------------------------------------------------

describe("epic-password-reset", () => {
  it("returns non-empty subject and html", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline()));
    expect(out.subject).toBeTruthy();
    expect(out.html).toBeTruthy();
  });

  it("subject is exactly '[HAVEN] Epic Account Reset'", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline()));
    expect(out.subject).toBe("[HAVEN] Epic Account Reset");
  });

  it("html contains the person name", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline()));
    expect(out.html).toContain("Alice Smith");
  });

  it("renders epicId when present", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline({ epicId: "ASMITH" })));
    expect(out.html).toContain("ASMITH");
  });

  it("uses 'pending assignment' fallback when epicId is null", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline({ epicId: null })));
    expect(out.html).toContain("pending assignment");
  });

  it("html mentions the temporary password", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline()));
    expect(out.html).toContain("SecureCare4u#25");
  });

  it("html contains key access instructions", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline()));
    expect(out.html).toContain("48 hours");
    expect(out.html).toContain("203-688-4357");
    expect(out.html).toContain("YM HAVEN FREE CLINIC");
  });

  it("HTML-escapes a malicious personName", async () => {
    const out = await renderEmail("epic-password-reset", epicPasswordResetContext(baseline({ personName: "<script>alert(1)</script>" })));
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// EpicTemplateKey type check (compile-time guard via assignment)
// ---------------------------------------------------------------------------

describe("EpicTemplateKey", () => {
  it("covers the three expected keys", () => {
    const keys: EpicTemplateKey[] = ["epic-onboarding", "epic-activation", "epic-password-reset"];
    expect(keys.length).toBe(3);
  });
});
