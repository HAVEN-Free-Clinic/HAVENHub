import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "./db";

// The message Prisma raised on CI when Postgres killed resetDb's TRUNCATE (#875, #876).
const DEADLOCK = "Raw query failed. Code: `40P01`. Message: `ERROR: deadlock detected`";

describe("resetDb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries the TRUNCATE when Postgres aborts it as a deadlock victim", async () => {
    const real = prisma.$executeRawUnsafe.bind(prisma);
    const spy = vi
      .spyOn(prisma, "$executeRawUnsafe")
      .mockRejectedValueOnce(new Error(DEADLOCK))
      .mockImplementation(real as never);

    await expect(resetDb()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not retry any other failure", async () => {
    const spy = vi.spyOn(prisma, "$executeRawUnsafe").mockRejectedValue(new Error("relation does not exist"));

    await expect(resetDb()).rejects.toThrow(/relation does not exist/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("gives up after three deadlocks instead of looping", async () => {
    const spy = vi.spyOn(prisma, "$executeRawUnsafe").mockRejectedValue(new Error(DEADLOCK));

    await expect(resetDb()).rejects.toThrow(/40P01/);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
