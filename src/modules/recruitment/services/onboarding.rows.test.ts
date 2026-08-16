import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { seedCycle } from "@/modules/recruitment/test/seed-cycle";
import { listOnboardingRows } from "./onboarding";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("listOnboardingRows", () => {
  // The table is a client component, so everything returned here is serialized
  // into the RSC payload. The contract row carries a standing-credential token.
  it("never exposes the onboarding token", async () => {
    const { cycleId, acceptances } = await seedCycle([{ contract: { status: "PENDING" } }]);
    const rows = await listOnboardingRows(cycleId);
    expect(JSON.stringify(rows)).not.toContain("tok-");
    expect(rows[0]).toEqual({
      acceptanceId: acceptances[0].id,
      contractId: acceptances[0].contractId,
      firstName: "First0",
      lastName: "Last0",
      departmentCode: "SRHD",
      state: "SENT",
      onRoster: false,
      customAnswers: [],
    });
  });

  it("marks a lapsed pending contract EXPIRED", async () => {
    const { cycleId } = await seedCycle([
      { contract: { status: "PENDING", expiresAt: new Date("2026-01-01T00:00:00Z") } },
    ]);
    const rows = await listOnboardingRows(cycleId, new Date("2026-08-07T12:00:00Z"));
    expect(rows[0].state).toBe("EXPIRED");
  });

  it("marks a still-live pending contract SENT", async () => {
    const { cycleId } = await seedCycle([
      { contract: { status: "PENDING", expiresAt: new Date("2026-12-01T00:00:00Z") } },
    ]);
    const rows = await listOnboardingRows(cycleId, new Date("2026-08-07T12:00:00Z"));
    expect(rows[0].state).toBe("SENT");
  });

  it("marks an acceptance with no contract NO_CONTRACT", async () => {
    const { cycleId } = await seedCycle([{}]);
    const rows = await listOnboardingRows(cycleId);
    expect(rows[0].state).toBe("NO_CONTRACT");
    expect(rows[0].contractId).toBeNull();
  });

  // Two acceptances on ONE application means two departments accepted the same
  // person. Both rows must read CONFLICT regardless of contract state.
  it("marks an application accepted by two departments CONFLICT", async () => {
    const { cycleId } = await seedCycle([
      { applicationKey: "shared", dept: "SRHD", contract: { status: "SUBMITTED" } },
      { applicationKey: "shared", dept: "PCAR" },
    ]);
    const rows = await listOnboardingRows(cycleId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "CONFLICT")).toBe(true);
  });

  it("sets onRoster once a contract has been promoted", async () => {
    const { cycleId, srrId } = await seedCycle([
      { contract: { status: "PROMOTED", promotedPersonId: null } },
    ]);
    await prisma.onboardingContract.updateMany({ data: { promotedPersonId: srrId } });
    const rows = await listOnboardingRows(cycleId);
    expect(rows[0].state).toBe("PROMOTED");
    expect(rows[0].onRoster).toBe(true);
  });

  it("resolves custom answers from the contract snapshot", async () => {
    const { cycleId } = await seedCycle([{
      contract: {
        status: "SUBMITTED",
        // custom_question requires `type` (a FieldType) and `required`; the
        // layout schema rejects the block without them.
        templateSnapshot: {
          blocks: [{
            kind: "custom_question", key: "tshirt", label: "T-shirt size",
            type: "SHORT_TEXT", required: false,
          }],
        },
        customAnswers: { tshirt: "M", confirm__strikes: "on" },
      },
    }]);
    const rows = await listOnboardingRows(cycleId);
    expect(rows[0].customAnswers).toEqual([{ label: "T-shirt size", value: "M" }]);
  });
});
