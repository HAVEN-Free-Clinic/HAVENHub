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
  // A contract this fresh (just flipped PENDING -> SUBMITTED) has not been
  // through promoteContracts, so no Person exists yet for a brand-new
  // volunteer; false is the realistic default here.
  lookupHasAccount: vi.fn(async () => false),
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
import { activeTermGroup } from "@/platform/posthog/groups";
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
      // A yale.edu address gets the SSO method; hasAccount false (mocked
      // above) suppresses the present-tense `text`, so only the roster-add-
      // phrased `emailText` is non-null; no cycle resolved -> training null;
      // epicNeeded false + no stored ID + hasEpic false -> no Epic line at
      // all (see onboarding-next-steps.ts).
      expect(res.nextSteps).toEqual({
        loginPath: "/login",
        signIn: {
          method: "sso",
          text: null,
          emailText: "Once a recruitment lead adds you to the roster, sign in with your Yale NetID.",
        },
        training: null,
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
      expect(res.nextSteps.training).toBeNull();
      expect(res.nextSteps.signIn.method).toBe("sso");
      expect(res.nextSteps.signIn.text).toBeNull();
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
      expect(res.nextSteps.training).toBeNull();
      expect(res.nextSteps.signIn.method).toBe("sso");
    }
  });

  // Minor fix verification: activeTermGroup runs its own unguarded
  // prisma.term.findFirst (platform/posthog/groups.ts) in the `groups`
  // argument position of captureEvent. captureEvent itself never throws, but
  // a rejection from activeTermGroup would previously escape past it, out of
  // this try, and turn an already-committed submission into "Something went
  // wrong" for the volunteer. The fix falls back to `undefined` (a no-op for
  // analytics grouping, not a broken capture) so the submission still
  // succeeds.
  it("still completes the submission when activeTermGroup rejects (e.g. a DB blip)", async () => {
    vi.mocked(activeTermGroup).mockRejectedValueOnce(new Error("db blip"));

    const fd = new FormData();
    fd.set("firstName", "Ada");
    fd.set("lastName", "Lovelace");
    fd.set("email", "ada@yale.edu");

    const res = await submitOnboarding("tok", fd);

    expect(res.ok).toBe(true);
    expect(vi.mocked(captureEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "onboarding_contract_submitted",
        distinctId: "ada@yale.edu",
        groups: undefined,
      }),
    );
  });
});
