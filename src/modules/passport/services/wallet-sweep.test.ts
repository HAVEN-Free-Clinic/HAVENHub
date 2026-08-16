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

function department() {
  return prisma.department.upsert({
    where: { code: "ITCM" },
    update: {},
    create: { code: "ITCM", name: "Internal Medicine" },
  });
}

/**
 * A badge, plus the roster row that justifies it. The membership is created by
 * default because a badge with no ACTIVE membership behind it is now itself a
 * revoke criterion (see the mid-term removal tests below); a helper that omitted
 * it would make every case look like a term-end case.
 */
async function passFor(opts: {
  termStatus: "ACTIVE" | "ARCHIVED";
  endDate: string;
  offboarded?: boolean;
  membershipStatus?: "ACTIVE" | "REMOVED";
}) {
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
  const dept = await department();
  await prisma.termMembership.create({
    data: {
      personId: person.id,
      termId: term.id,
      departmentId: dept.id,
      kind: "VOLUNTEER",
      status: opts.membershipStatus ?? "ACTIVE",
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
    // Only Date is faked (see the calendar-day tests): faking every timer would
    // stall the pg client's own timeouts mid-query.
    vi.useRealTimers();
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

  it("revokes the badge of a member removed from the roster mid-term", async () => {
    // The gap the sweep had: withdrawFromTerm and a mid-term roster removal both
    // flip the membership to REMOVED and leave Person.status ACTIVE, so neither
    // of the two original criteria (term ended, person offboarded) fired. The
    // badge asserts PRESENT standing and stayed scannable until term end.
    await passFor({
      termStatus: "ACTIVE",
      endDate: "2099-01-01T12:00:00Z",
      membershipStatus: "REMOVED",
    });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 1, failed: 0 });
  });

  it("revokes when the only ACTIVE membership left is in an ARCHIVED term", async () => {
    // Standing is judged in the non-archived scope offboarding uses
    // (OFFBOARDABLE_TERM). A membership in a term that is over is history, not a
    // place here, so it must not keep a badge alive.
    const pass = await passFor({
      termStatus: "ACTIVE",
      endDate: "2099-01-01T12:00:00Z",
      membershipStatus: "REMOVED",
    });
    const old = await prisma.term.create({
      data: {
        code: "OLD1",
        name: "Old",
        startDate: new Date("2020-01-01T12:00:00Z"),
        endDate: new Date("2020-06-01T12:00:00Z"),
        status: "ARCHIVED",
      },
    });
    const dept = await department();
    await prisma.termMembership.create({
      data: { personId: pass.personId, termId: old.id, departmentId: dept.id, kind: "VOLUNTEER" },
    });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 1, failed: 0 });
  });

  it("leaves the badge of a member who still holds a PLANNING-term membership", async () => {
    // The other side of the same rule: this clinic rosters the next term ahead
    // of the ACTIVE flip, so a PLANNING membership is a real place here.
    const pass = await passFor({
      termStatus: "ACTIVE",
      endDate: "2099-01-01T12:00:00Z",
      membershipStatus: "REMOVED",
    });
    const next = await prisma.term.create({
      data: {
        code: "NXT1",
        name: "Next",
        startDate: new Date("2099-01-02T12:00:00Z"),
        endDate: new Date("2099-06-01T12:00:00Z"),
        status: "PLANNING",
      },
    });
    const dept = await department();
    await prisma.termMembership.create({
      data: { personId: pass.personId, termId: next.id, departmentId: dept.id, kind: "DIRECTOR" },
    });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 0 });
    expect(revokePassMock).not.toHaveBeenCalled();
  });

  it("does not treat a term ending TODAY as ended", async () => {
    // endDate is a noon-UTC calendar marker, so comparing it against a raw
    // instant made every badge for a term ending today sweepable from 08:00 ET,
    // killing badges in the middle of the term's final clinic day. 16:00Z is
    // noon in the display zone, well past that old cutover and still the same
    // calendar day in both zones.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T16:00:00Z"));
    await passFor({ termStatus: "ACTIVE", endDate: "2026-08-31T12:00:00Z" });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 0 });
    expect(revokePassMock).not.toHaveBeenCalled();
  });

  it("revokes once the term's last calendar day has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T16:00:00Z"));
    await passFor({ termStatus: "ACTIVE", endDate: "2026-08-31T12:00:00Z" });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 1, failed: 0 });
  });

  it("is idempotent: an already-revoked pass is not revoked again", async () => {
    const pass = await passFor({ termStatus: "ARCHIVED", endDate: "2020-01-01T12:00:00Z" });
    await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
    revokePassMock.mockResolvedValue(true);

    expect(await sweepWalletPasses()).toEqual({ revoked: 0, failed: 0 });
    expect(revokePassMock).not.toHaveBeenCalled();
  });
});
