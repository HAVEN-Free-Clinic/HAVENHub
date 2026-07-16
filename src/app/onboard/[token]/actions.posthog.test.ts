import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/recruitment/services/onboarding", () => ({
  submitContract: vi.fn(async () => ({ email: "ada@yale.edu" })),
  ContractError: class ContractError extends Error {},
  ContractValidationError: class ContractValidationError extends Error {},
}));
vi.mock("@/modules/recruitment/contract/signatures", () => ({
  collectSignatureInputs: vi.fn(() => ({})),
}));
vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));
vi.mock("@/platform/posthog/groups", () => ({
  activeTermGroup: vi.fn(async () => ({ term: "term-1" })),
}));

import { submitOnboarding } from "./actions";
import { captureEvent } from "@/platform/posthog/capture";

beforeEach(() => vi.clearAllMocks());

describe("submitOnboarding PostHog event", () => {
  it("fires onboarding_contract_submitted with the applicant email on success", async () => {
    const fd = new FormData();
    fd.set("firstName", "Ada");
    fd.set("lastName", "Lovelace");
    fd.set("email", "ada@yale.edu");

    const res = await submitOnboarding("tok", fd);

    expect(res).toEqual({ ok: true });
    expect(vi.mocked(captureEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "onboarding_contract_submitted",
        distinctId: "ada@yale.edu",
      }),
    );
  });
});
