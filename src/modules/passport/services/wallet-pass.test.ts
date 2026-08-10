import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { issueWalletPass, revokeWalletPasses, shortenSince } from "./wallet-pass";
import { createPass, isWalletEnabled, revokePass, updatePass } from "./wallet-client";

// vi.mock, not vi.spyOn: wallet-pass.ts imports these as named bindings, and
// spying on an ESM namespace object does not rebind what the importer already
// holds. This mirrors the partial-mock pattern in my-info.test.ts.
vi.mock("./wallet-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wallet-client")>();
  return {
    ...actual,
    isWalletEnabled: vi.fn(() => true),
    createPass: vi.fn(),
    updatePass: vi.fn(),
    revokePass: vi.fn(),
  };
});

const createPassMock = vi.mocked(createPass);
const updatePassMock = vi.mocked(updatePass);
const revokePassMock = vi.mocked(revokePass);
const isWalletEnabledMock = vi.mocked(isWalletEnabled);

const HOUR_MS = 60 * 60 * 1000;

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

  it("clamps expirationDays to 1 for a term ending within the day", async () => {
    // Deliberately a term ending SOON, not one already ended: an ended term is
    // refused outright now (see the test below), so a past end date would no
    // longer reach the clamp at all.
    const { person } = await seedActiveMember(new Date(Date.now() + HOUR_MS));
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const input = createPassMock.mock.calls[0][0];
    expect(input.expirationDays).toBe(1);
  });

  it("refuses to issue when the resolved term has already ended", async () => {
    // getActiveTerm filters on status alone, so a term that has ended but has
    // not been flipped to ARCHIVED still resolves. Issuing there would resurrect
    // exactly the badge the reconciliation sweep revokes for an ended term.
    const { person } = await seedActiveMember(new Date("2020-01-01T12:00:00Z"));
    createPassMock.mockResolvedValue(CREATED);

    expect(await issueWalletPass(person.id)).toBeNull();
    expect(createPassMock).not.toHaveBeenCalled();
    expect(updatePassMock).not.toHaveBeenCalled();
    expect(await prisma.walletPass.count()).toBe(0);
  });

  it("refreshes the live pass in place on re-issue instead of minting a second one", async () => {
    const { person, term } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);
    // What the vendor ACTUALLY returns from a PUT, verified against the live API
    // on 2026-08-10: an acknowledgement with no install URLs.
    updatePassMock.mockResolvedValue({
      serialNumber: "ser_1",
      notifiedDevices: 2,
      unchanged: false,
    });

    await issueWalletPass(person.id);
    const second = await issueWalletPass(person.id);

    // A second create would mint a serial that replaces ser_1 in the row, and
    // ser_1 would then be unreachable by revokeWalletPasses and by the sweep.
    expect(createPassMock).toHaveBeenCalledTimes(1);
    expect(updatePassMock).toHaveBeenCalledTimes(1);
    expect(updatePassMock).toHaveBeenCalledWith("ser_1", expect.anything());
    // The links come from the stored row, since the refresh response has none.
    // Before the URLs were persisted this returned {undefined, undefined} typed
    // as string, and the card rendered links with undefined hrefs.
    expect(second).toEqual({ googleSaveUrl: "https://g", shareUrl: "https://s" });

    expect(await prisma.walletPass.count()).toBe(1);
    const row = await prisma.walletPass.findUnique({
      where: { personId_termId: { personId: person.id, termId: term.id } },
    });
    expect(row!.serialNumber).toBe("ser_1");
  });

  it("puts the published credential URL in the QR, and no barcode when unpublished", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    // Unpublished: no credential row at all.
    await issueWalletPass(person.id);
    expect(createPassMock.mock.calls[0][0].barcodeValue).toBeNull();

    // Published: the QR resolves to the page a third party can actually check.
    await prisma.serviceCredential.create({
      data: { personId: person.id, record: {}, publicToken: "tok_abc" },
    });
    await prisma.walletPass.deleteMany({ where: { personId: person.id } });
    await issueWalletPass(person.id);
    expect(createPassMock.mock.calls[1][0].barcodeValue).toContain("/credential/tok_abc");
  });

  it("gives a revoked credential no barcode, so the QR never resolves to a 404", async () => {
    const { person } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);
    await prisma.serviceCredential.create({
      data: {
        personId: person.id,
        record: {},
        publicToken: "tok_dead",
        revokedAt: new Date(),
      },
    });

    await issueWalletPass(person.id);

    expect(createPassMock.mock.calls[0][0].barcodeValue).toBeNull();
  });

  it("names the role in logoText so a director's badge does not read Volunteer", async () => {
    const { person, term } = await seedActiveMember();
    const dept = await prisma.department.findUniqueOrThrow({ where: { code: "ITCM" } });
    await prisma.termMembership.deleteMany({ where: { personId: person.id } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR" },
    });
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const input = createPassMock.mock.calls[0][0];
    expect(input.logoText).toBe("Director Identification");
    expect(input.primaryFields[0].value).toBe("Director");
  });

  it("persists the install URLs at creation, because a refresh cannot return them", async () => {
    const { person, term } = await seedActiveMember();
    createPassMock.mockResolvedValue(CREATED);

    await issueWalletPass(person.id);

    const row = await prisma.walletPass.findUnique({
      where: { personId_termId: { personId: person.id, termId: term.id } },
    });
    expect(row!.googleSaveUrl).toBe("https://g");
    expect(row!.shareUrl).toBe("https://s");
  });

  it("returns null when a refreshed row predates the stored install URLs", async () => {
    const { person, term } = await seedActiveMember();
    // A row written before the columns existed: refreshable, but there is no
    // link to hand back, so this degrades like any other unavailable badge.
    await prisma.walletPass.create({
      data: { personId: person.id, termId: term.id, serialNumber: "ser_old" },
    });
    updatePassMock.mockResolvedValue({
      serialNumber: "ser_old",
      notifiedDevices: 0,
      unchanged: true,
    });

    expect(await issueWalletPass(person.id)).toBeNull();
    expect(createPassMock).not.toHaveBeenCalled();
  });

  it("returns null rather than creating a duplicate when the refresh fails", async () => {
    const { person, term } = await seedActiveMember();
    await prisma.walletPass.create({
      data: { personId: person.id, termId: term.id, serialNumber: "ser_1" },
    });
    updatePassMock.mockResolvedValue(null);
    createPassMock.mockResolvedValue(CREATED);

    expect(await issueWalletPass(person.id)).toBeNull();
    expect(createPassMock).not.toHaveBeenCalled();
    const row = await prisma.walletPass.findFirst({ where: { personId: person.id } });
    expect(row!.serialNumber).toBe("ser_1");
  });

  it("creates a fresh pass when the only row for the term is already revoked", async () => {
    const { person, term } = await seedActiveMember();
    await prisma.walletPass.create({
      data: {
        personId: person.id,
        termId: term.id,
        serialNumber: "ser_old",
        revokedAt: new Date(),
      },
    });
    createPassMock.mockResolvedValue(CREATED);

    // ser_old is already deleted at the vendor, so there is nothing to orphan.
    expect(await issueWalletPass(person.id)).toEqual({
      googleSaveUrl: "https://g",
      shareUrl: "https://s",
    });
    expect(updatePassMock).not.toHaveBeenCalled();
    const row = await prisma.walletPass.findFirst({ where: { personId: person.id } });
    expect(row!.serialNumber).toBe("ser_1");
    expect(row!.revokedAt).toBeNull();
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

describe("shortenSince", () => {
  it("keeps a term name as is", () => {
    expect(shortenSince("Spring 2026")).toBe("Spring 2026");
  });

  it("strips the recruitment boilerplate a recruitment-derived label carries", () => {
    // computeServiceRecord uses HistoricalApplication.cycleLabel for pre-roster
    // terms, which is far too long for a secondary field on a card.
    expect(shortenSince("Fall 2023 Volunteer Recruitment")).toBe("Fall 2023");
    expect(shortenSince("Summer 2025 Director Recruitment")).toBe("Summer 2025");
  });

  it("falls back to the year when there is no season", () => {
    expect(shortenSince("Cycle of 2022")).toBe("2022");
  });

  it("returns the label unchanged when it has no year at all", () => {
    expect(shortenSince("Founding cohort")).toBe("Founding cohort");
  });
});
