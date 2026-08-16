import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/modules/onboarding/services/onboarding", () => ({ getOnboardingStatus: vi.fn() }));
vi.mock("@/modules/my-info/services/my-info", () => ({ listMyCertificates: vi.fn() }));

import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { myClearanceStatusTool } from "./compliance";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

type Task = {
  key: string;
  label: string;
  description: string;
  state: "COMPLETE" | "IN_PROGRESS" | "INCOMPLETE" | "NOT_REQUIRED";
  blocking: boolean;
};

function status(opts: { hasActiveTerm?: boolean; cleared?: boolean; tasks?: Task[] }) {
  const tasks = opts.tasks ?? [];
  return {
    hasActiveTerm: opts.hasActiveTerm ?? true,
    exempt: false,
    tasks,
    completedCount: tasks.filter((t) => t.state === "COMPLETE" || t.state === "NOT_REQUIRED").length,
    totalCount: tasks.length,
    onboarded: opts.cleared ?? true,
    cleared: opts.cleared ?? true,
  };
}

function cert(completionDate: string | null) {
  return { completionDate: completionDate ? new Date(completionDate) : null };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("my_clearance_status", () => {
  it("says so plainly when the member is cleared", async () => {
    mocked(getOnboardingStatus).mockResolvedValue(
      status({ cleared: true, tasks: [{ key: "hipaa", label: "HIPAA certificate", description: "d", state: "COMPLETE", blocking: true }] })
    );

    const text = await myClearanceStatusTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/you are cleared/i);
    expect(text).not.toMatch(/outstanding/i);
  });

  it("tells a not-cleared member WHAT is outstanding, not just that they are not cleared", async () => {
    mocked(getOnboardingStatus).mockResolvedValue(
      status({
        cleared: false,
        tasks: [
          { key: "hipaa", label: "HIPAA certificate", description: "d", state: "COMPLETE", blocking: true },
          {
            key: "training",
            label: "Volunteer training",
            description: "Finish this term's training to be cleared for shifts.",
            state: "INCOMPLETE",
            blocking: true,
          },
        ],
      })
    );

    const text = await myClearanceStatusTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/not yet cleared/i);
    // The useless answer stops here; this tool must not.
    expect(text).toContain("Volunteer training");
    expect(text).toContain("Finish this term's training to be cleared for shifts.");
    // The COMPLETE hipaa task is satisfied, so it must not show up as outstanding.
    expect(text).not.toContain("HIPAA certificate:");
  });

  it("renders the cleared and not-cleared answers distinguishably", async () => {
    mocked(getOnboardingStatus).mockResolvedValueOnce(status({ cleared: true, tasks: [] }));
    const clearedText = await myClearanceStatusTool.run({ personId: "p1" }, {});

    mocked(getOnboardingStatus).mockResolvedValueOnce(
      status({
        cleared: false,
        tasks: [{ key: "learning", label: "Learning modules", description: "Complete your assigned courses.", state: "INCOMPLETE", blocking: true }],
      })
    );
    const notClearedText = await myClearanceStatusTool.run({ personId: "p1" }, {});

    expect(clearedText).not.toBe(notClearedText);
    expect(clearedText).toMatch(/cleared/i);
    expect(notClearedText).toMatch(/not yet cleared/i);
  });

  it("says there is no active term rather than claiming clearance either way", async () => {
    mocked(getOnboardingStatus).mockResolvedValue(status({ hasActiveTerm: false, cleared: true, tasks: [] }));

    const text = await myClearanceStatusTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/no active clinic term/i);
    expect(mocked(listMyCertificates)).not.toHaveBeenCalled();
  });

  it("names the expiry date for an outstanding HIPAA cert that has actually expired", async () => {
    mocked(getOnboardingStatus).mockResolvedValue(
      status({
        cleared: false,
        tasks: [{ key: "hipaa", label: "HIPAA certificate", description: "Upload a current certificate.", state: "INCOMPLETE", blocking: true }],
      })
    );
    // completionDate is stored at noon UTC (see completion-date.ts), same
    // convention as clinicDate; certExpiresAt adds exactly 365 days.
    mocked(listMyCertificates).mockResolvedValue([cert("2025-08-03T12:00:00Z")]);

    const text = await myClearanceStatusTool.run({ personId: "p1" }, {});

    // formatCalendarDate (UTC), not a zoned formatter: a zoned render of this
    // same UTC-noon instant in a US zone could still land on Aug 3, so this
    // assertion is the one that actually distinguishes the two -- the DOB/date
    // guard test elsewhere in this suite covers the zoning bug shape directly.
    expect(text).toContain("expired on Aug 3, 2026");
  });

  it("does not invent an expiry date when there is no certificate on file at all", async () => {
    mocked(getOnboardingStatus).mockResolvedValue(
      status({
        cleared: false,
        tasks: [{ key: "hipaa", label: "HIPAA certificate", description: "Upload a current certificate.", state: "INCOMPLETE", blocking: true }],
      })
    );
    mocked(listMyCertificates).mockResolvedValue([]);

    const text = await myClearanceStatusTool.run({ personId: "p1" }, {});

    expect(text).not.toMatch(/expired on/i);
    expect(text).toContain("Upload a current certificate.");
  });

  it("does not look up certificates for a hipaa task that is merely in progress, not incomplete", async () => {
    mocked(getOnboardingStatus).mockResolvedValue(
      status({
        cleared: false,
        tasks: [
          {
            key: "hipaa",
            label: "HIPAA certificate",
            description: "We have your certificate. A compliance manager is reviewing it.",
            state: "IN_PROGRESS",
            blocking: true,
          },
        ],
      })
    );

    const text = await myClearanceStatusTool.run({ personId: "p1" }, {});

    expect(mocked(listMyCertificates)).not.toHaveBeenCalled();
    expect(text).toContain("A compliance manager is reviewing it.");
  });

  it("reads only the caller's own record", async () => {
    mocked(getOnboardingStatus).mockResolvedValue(status({ cleared: true, tasks: [] }));

    await myClearanceStatusTool.run({ personId: "p1" }, {});

    expect(mocked(getOnboardingStatus)).toHaveBeenCalledWith("p1");
    expect(mocked(getOnboardingStatus)).toHaveBeenCalledTimes(1);
  });

  it("takes no input at all, so nothing about the request is model-chosen", () => {
    expect(Object.keys(myClearanceStatusTool.inputSchema.shape)).toEqual([]);
  });
});
