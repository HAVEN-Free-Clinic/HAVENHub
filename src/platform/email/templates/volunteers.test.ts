import { describe, expect, it } from "vitest";
import { selfWithdrawalContext, volunteersDescriptors } from "./volunteers";
import { renderTemplate } from "@/platform/email/render/render";

const descriptor = volunteersDescriptors[0];

function render(context: Record<string, unknown>) {
  return renderTemplate(descriptor.defaultBody, context);
}

describe("selfWithdrawalContext", () => {
  it("flattens a reason into the text plus a hasReason boolean", () => {
    const ctx = selfWithdrawalContext({
      memberName: "Jane Doe",
      departments: "MED, PCAR",
      reason: "Graduating in May.",
      stillActive: false,
      reviewLink: "https://hub.test/volunteers/offboarding",
    });

    expect(ctx.reason).toBe("Graduating in May.");
    expect(ctx.hasReason).toBe(true);
  });

  it("reports hasReason false when no reason was given", () => {
    const ctx = selfWithdrawalContext({
      memberName: "Jane Doe",
      departments: "MED",
      reason: null,
      stillActive: false,
      reviewLink: "https://hub.test/volunteers/offboarding",
    });

    expect(ctx.reason).toBe("");
    expect(ctx.hasReason).toBe(false);
  });
});

describe("volunteers.self_withdrawal template", () => {
  it("is registered under the volunteers group", () => {
    expect(descriptor.key).toBe("volunteers.self_withdrawal");
    expect(descriptor.group).toBe("volunteers");
  });

  it("names the member and departments, and says they are flagged", () => {
    const html = render(
      selfWithdrawalContext({
        memberName: "Jane Doe",
        departments: "MED, PCAR",
        reason: null,
        stillActive: false,
        reviewLink: "https://hub.test/volunteers/offboarding",
      }),
    );

    expect(html).toContain("Jane Doe");
    expect(html).toContain("MED, PCAR");
    expect(html).toContain("flagged for offboarding");
    expect(html).not.toContain("Reason given");
  });

  it("includes the reason when one was given", () => {
    const html = render(
      selfWithdrawalContext({
        memberName: "Jane Doe",
        departments: "MED",
        reason: "Graduating in May.",
        stillActive: false,
        reviewLink: "https://hub.test/volunteers/offboarding",
      }),
    );

    expect(html).toContain("Reason given");
    expect(html).toContain("Graduating in May.");
  });

  it("says no action is needed when the member keeps another active role", () => {
    const html = render(
      selfWithdrawalContext({
        memberName: "Jane Doe",
        departments: "MED",
        reason: null,
        stillActive: true,
        reviewLink: "https://hub.test/volunteers/offboarding",
      }),
    );

    expect(html).toContain("still hold");
    expect(html).not.toContain("flagged for offboarding");
  });
});
