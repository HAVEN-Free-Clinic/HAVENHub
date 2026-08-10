import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { sweepWalletPasses } from "./wallet-sweep";
import { isWalletEnabled, revokePass } from "./wallet-client";

// vi.mock, not vi.spyOn: see the note in wallet-pass.test.ts.
vi.mock("./wallet-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wallet-client")>();
  return { ...actual, isWalletEnabled: vi.fn(() => true), revokePass: vi.fn() };
});

const revokePassMock = vi.mocked(revokePass);
const isWalletEnabledMock = vi.mocked(isWalletEnabled);

async function passFor(opts: { termStatus: "ACTIVE" | "ARCHIVED"; endDate: string; offboarded?: boolean }) {
  const person = await prisma.person.create({
    data: { name: "Ada", status: opts.offboarded ? "OFFBOARDED" : "ACTIVE" },
  });
  const term = await prisma.term.create({
    data: {
      code: `T${Math.random().toString(36).slice(2, 8)}`,
      name: "Term",
      startDate: new Date("2026-01-01T12:00:00Z"),
      endDate: new Date(opts.endDate),
      status: opts.termStatus,
    },
  });
  return prisma.walletPass.create({
    data: { personId: person.id, termId: term.id, serialNumber: `ser_${term.code}` },
  });
}

describe("sweepWalletPasses", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    isWalletEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revokes a pass whose term has ended", async () => {
    await passFor({ termStatus: "ARCHIVED", endDate: "2020-01-01T12:00:00Z" });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 1, failed: 0 });
  });

  it("revokes a pass belonging to an offboarded person", async () => {
    await passFor({ termStatus: "ACTIVE", endDate: "2099-01-01T12:00:00Z", offboarded: true });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 1, failed: 0 });
  });

  it("leaves a live pass for an active member alone", async () => {
    await passFor({ termStatus: "ACTIVE", endDate: "2099-01-01T12:00:00Z" });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 0 });
    expect(revokePassMock).not.toHaveBeenCalled();
  });

  it("counts a vendor failure and leaves the row for the next run", async () => {
    const pass = await passFor({ termStatus: "ARCHIVED", endDate: "2020-01-01T12:00:00Z" });
    revokePassMock.mockResolvedValue(false);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 1 });
    const row = await prisma.walletPass.findUnique({ where: { id: pass.id } });
    expect(row!.revokedAt).toBeNull();
  });

  it("is idempotent: an already-revoked pass is not revoked again", async () => {
    const pass = await passFor({ termStatus: "ARCHIVED", endDate: "2020-01-01T12:00:00Z" });
    await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 0 });
    expect(revokePassMock).not.toHaveBeenCalled();
  });
});
