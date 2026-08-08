import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { seedCycle } from "@/modules/recruitment/test/seed-cycle";
import { withdrawContracts } from "./onboarding";
import { RecruitmentAuthError } from "./review";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

const twoPending = () => seedCycle([
  { contract: { status: "PENDING" } },
  { contract: { status: "PENDING" } },
]);

describe("withdrawContracts", () => {
  it("withdraws every eligible contract and reports the count", async () => {
    const { srrId, acceptances } = await twoPending();
    const ids = acceptances.map((a) => a.contractId!);
    const res = await withdrawContracts(ids, srrId);
    expect(res).toEqual({ withdrawn: 2, skipped: 0, failed: 0 });
    expect(await prisma.onboardingContract.count({ where: { id: { in: ids } } })).toBe(0);
  });

  // A promoted person is on the roster; the reversal is offboarding, not a
  // withdraw. It must not abort the rest of the batch.
  it("skips a promoted contract instead of failing the batch", async () => {
    const { srrId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
      { contract: { status: "PROMOTED" } },
    ]);
    const [pending, promoted] = acceptances;
    const res = await withdrawContracts([pending.contractId!, promoted.contractId!], srrId);
    expect(res).toEqual({ withdrawn: 1, skipped: 1, failed: 0 });
    expect(await prisma.onboardingContract.count({ where: { id: promoted.contractId! } })).toBe(1);
  });

  it("skips an id that does not exist", async () => {
    const { srrId } = await twoPending();
    const res = await withdrawContracts(["does-not-exist"], srrId);
    expect(res).toEqual({ withdrawn: 0, skipped: 1, failed: 0 });
  });

  it("returns a zero result for an empty batch", async () => {
    const { srrId } = await twoPending();
    expect(await withdrawContracts([], srrId)).toEqual({ withdrawn: 0, skipped: 0, failed: 0 });
  });

  // Authorization is checked once for the batch, not per contract, so a caller
  // without the permission gets a hard error rather than a silent zero-count.
  it("throws for an actor without recruitment.review_all", async () => {
    const { plainId, acceptances } = await twoPending();
    const ids = acceptances.map((a) => a.contractId!);
    await expect(withdrawContracts(ids, plainId)).rejects.toBeInstanceOf(RecruitmentAuthError);
    expect(await prisma.onboardingContract.count({ where: { id: { in: ids } } })).toBe(2);
  });
});
