import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/recruitment/services/onboarding", () => ({
  submitContract: vi.fn(async () => ({
    email: "ada@yale.edu",
    netId: null,
    acceptanceId: "acc-1",
    epicNeeded: false,
    hasEpic: false,
  })),
  lookupStoredEpicId: vi.fn(async () => null),
  ContractError: class ContractError extends Error {},
  ContractValidationError: class ContractValidationError extends Error {},
}));
vi.mock("@/modules/recruitment/contract/signatures", () => ({
  collectSignatureInputs: vi.fn(() => ({})),
}));
// resolveNextSteps (actions.ts) re-derives training date/location from the
// acceptance -> application -> cycle chain and the display time zone; neither
// is under test here, so both are stubbed to a "no cycle found" shape that
// exercises buildOnboardingNextSteps's own null-cycle fallback.
vi.mock("@/platform/db", () => ({
  prisma: { acceptance: { findUnique: vi.fn(async () => null) } },
}));
vi.mock("@/platform/dates/resolve", () => ({
  getDisplayTimeZone: vi.fn(async () => "America/New_York"),
}));
vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));
vi.mock("@/platform/posthog/groups", () => ({
  activeTermGroup: vi.fn(async () => ({ term: "term-1" })),
}));
// Spies on the real buildOnboardingNextSteps by default (so the first two
// tests exercise the actual content builder), overridden per-call in the
// "content builder itself throws" test below.
vi.mock("@/modules/recruitment/onboarding-next-steps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/recruitment/onboarding-next-steps")>();
  return { ...actual, buildOnboardingNextSteps: vi.fn(actual.buildOnboardingNextSteps) };
});

import { submitOnboarding } from "./actions";
import { captureEvent } from "@/platform/posthog/capture";
import { prisma } from "@/platform/db";
import { buildOnboardingNextSteps } from "@/modules/recruitment/onboarding-next-steps";

beforeEach(() => vi.clearAllMocks());

describe("submitOnboarding PostHog event", () => {
  it("fires onboarding_contract_submitted with the applicant email on success", async () => {
    const fd = new FormData();
    fd.set("firstName", "Ada");
    fd.set("lastName", "Lovelace");
    fd.set("email", "ada@yale.edu");

    const res = await submitOnboarding("tok", fd);

    expect(res.ok).toBe(true);
    if (res.ok) {
      // A yale.edu address gets the SSO line; no cycle resolved -> the
      // "scheduled training date" fallback; epicNeeded false + no stored ID
      // + hasEpic false -> no Epic line at all (see onboarding-next-steps.ts).
      expect(res.nextSteps).toEqual({
        loginPath: "/login",
        signIn: { method: "sso", text: "Sign in with your Yale NetID." },
        training: "Plan to attend in-person training on the scheduled training date.",
        epic: null,
        review: "A recruitment lead will review your submission and add you to the roster.",
      });
    }
    expect(vi.mocked(captureEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "onboarding_contract_submitted",
        distinctId: "ada@yale.edu",
      }),
    );
  });

  // The contract is already durably SUBMITTED by the time resolveNextSteps runs
  // its extra lookups (actions.ts), so a failure there must degrade to generic
  // completion content, not surface as a failed submission -- otherwise a DB
  // hiccup after a successful submit tells the volunteer to retry a form that
  // has already gone through.
  it("still returns ok with generic completion content when the post-submit next-steps lookup fails", async () => {
    vi.mocked(prisma.acceptance.findUnique).mockRejectedValueOnce(new Error("boom"));

    const fd = new FormData();
    fd.set("firstName", "Ada");
    fd.set("lastName", "Lovelace");
    fd.set("email", "ada@yale.edu");

    const res = await submitOnboarding("tok", fd);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.nextSteps.training).toBe("Plan to attend in-person training on the scheduled training date.");
      expect(res.nextSteps.signIn.method).toBe("sso");
    }
  });

  // Regression test for the gap a reviewer caught: an earlier version of
  // resolveNextSteps (actions.ts) only wrapped the three lookups in a try,
  // leaving the buildOnboardingNextSteps call itself outside it. That was
  // harmless only because every field it reads happens to be non-optional
  // today; this proves a throw from the content builder -- not just a DB
  // lookup -- is caught too, rather than escaping as a false "submission
  // failed" on a contract that already committed.
  it("still returns ok with generic completion content when the content builder itself throws", async () => {
    vi.mocked(buildOnboardingNextSteps).mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const fd = new FormData();
    fd.set("firstName", "Ada");
    fd.set("lastName", "Lovelace");
    fd.set("email", "ada@yale.edu");

    const res = await submitOnboarding("tok", fd);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.nextSteps.training).toBe("Plan to attend in-person training on the scheduled training date.");
      expect(res.nextSteps.signIn.method).toBe("sso");
    }
  });
});
