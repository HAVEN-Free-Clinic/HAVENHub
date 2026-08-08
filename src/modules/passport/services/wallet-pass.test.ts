import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { issueWalletPass, revokeWalletPasses } from "./wallet-pass";
import { createPass, isWalletEnabled, revokePass } from "./wallet-client";

// vi.mock, not vi.spyOn: wallet-pass.ts imports these as named bindings, and
// spying on an ESM namespace object does not rebind what the importer already
// holds. This mirrors the partial-mock pattern in my-info.test.ts.
vi.mock("./wallet-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wallet-client")>();
  return {
    ...actual,
    isWalletEnabled: vi.fn(() => true),
    createPass: vi.fn(),
    revokePass: vi.fn(),
  };
});

const createPassMock = vi.mocked(createPass);
const revokePassMock = vi.mocked(revokePass);
const isWalletEnabledMock = vi.mocked(isWalletEnabled);

async function seedActiveMember(termEndDate: Date = new Date("2099-08-31T12:00:00Z")) {
  const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
  const dept = await prisma.department.upsert({
    where: { code: "ITCM" },
    update: {},
    create: { code: "ITCM", name: "Internal Medicine" },
  });
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: termEndDate,
      status: "ACTIVE",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
  });
  return { person, term };
}

const CREATED = {
  serialNumber: "ser_1",
  googleSaveUrl: "https://g",
  applePass: "b64",
  shareUrl: "https://s",
};

describe("issueWalletPass", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    isWalletEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pass and stores the serial", async () => {
    const { person, term } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    const result = await issueWalletPass(person.id);

    expect(result).toEqual({ googleSaveUrl: "https://g", shareUrl: "https://s" });
    const row = await prisma.walletPass.findUnique({
      where: { personId_termId: { personId: person.id, termId: term.id } },
    });
    expect(row!.serialNumber).toBe("ser_1");
  });

  it("computes expirationDays from the term end date", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const input = createPassMock.mock.calls[0][0];
    expect(input.expirationDays).toBeGreaterThan(0);
    expect(input.expirationDays).toBeLessThanOrEqual(3650);
  });

  it("clamps expirationDays to 1 when the term end date is in the past", async () => {
    const { person } = await seedActiveMember(new Date("2020-01-01T12:00:00Z"));
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const input = createPassMock.mock.calls[0][0];
    expect(input.expirationDays).toBe(1);
  });

  it("puts the role, department, term, and member-since year on the pass", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const input = createPassMock.mock.calls[0][0];
    expect(input.primaryFields[0].value).toBe("Volunteer");
    const labels = input.secondaryFields.map((f) => f.label);
    expect(labels).toContain("Department");
    expect(labels).toContain("Term");
    expect(labels).toContain("Member since");
  });

  it("returns null and stores nothing when the vendor fails", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(null);

    expect(await issueWalletPass(person.id)).toBeNull();
    expect(await prisma.walletPass.count()).toBe(0);
  });

  it("returns null when the member has no active membership", async () => {
    const person = await prisma.person.create({ data: { name: "No Term" } });

    expect(await issueWalletPass(person.id)).toBeNull();
    expect(createPassMock).not.toHaveBeenCalled();
  });
});

describe("revokeWalletPasses", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    isWalletEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revokes at the vendor and marks the row", async () => {
    const { person, term } = await seedActiveMember();
    await prisma.walletPass.create({
      data: { personId: person.id, termId: term.id, serialNumber: "ser_1" },
    });
    revokePassMock.mockResolvedValue(true);

    expect(await revokeWalletPasses(person.id)).toBe(1);
    expect(revokePassMock).toHaveBeenCalledWith("ser_1");
    const row = await prisma.walletPass.findFirst({ where: { personId: person.id } });
    expect(row!.revokedAt).not.toBeNull();
  });

  it("leaves the row unmarked when the vendor call fails, so the sweep retries", async () => {
    const { person, term } = await seedActiveMember();
    await prisma.walletPass.create({
      data: { personId: person.id, termId: term.id, serialNumber: "ser_1" },
    });
    revokePassMock.mockResolvedValue(false);

    expect(await revokeWalletPasses(person.id)).toBe(0);
    const row = await prisma.walletPass.findFirst({ where: { personId: person.id } });
    expect(row!.revokedAt).toBeNull();
  });
});
