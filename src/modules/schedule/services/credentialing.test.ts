import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { AttendingForbiddenError } from "./attendings";
import { listCredentialing, outstandingSteps, updateCredentialing } from "./credentialing";

const ACTOR = "actor-1";

async function grantManageAttendings(personId = ACTOR) {
  await prisma.person.upsert({
    where: { id: personId },
    update: {},
    create: { id: personId, name: "FCRL Director" },
  });
  const role = await prisma.role.create({
    data: {
      name: `r-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission: "schedule.manage_attendings" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function attending(scheduleName: string) {
  return prisma.attending.create({ data: { scheduleName, fullName: scheduleName } });
}

beforeEach(resetDb);

describe("updateCredentialing", () => {
  it("refuses an actor without schedule.manage_attendings", async () => {
    const nobody = await prisma.person.create({ data: { name: "Nobody" } });
    const a = await attending("Rivera");
    await expect(
      updateCredentialing(nobody.id, a.id, { infoEmailSent: true }),
    ).rejects.toBeInstanceOf(AttendingForbiddenError);
  });

  // The first save is also the start of tracking, so it must create the row
  // rather than erroring on a missing one.
  it("creates the row on the first save", async () => {
    await grantManageAttendings();
    const a = await attending("Rivera");

    const row = await updateCredentialing(ACTOR, a.id, { infoEmailSent: true });

    expect(row.infoEmailSent).toBe(true);
    expect(row.approved).toBe(false);
  });

  it("records later stages onto the same row", async () => {
    await grantManageAttendings();
    const a = await attending("Rivera");

    await updateCredentialing(ACTOR, a.id, { infoEmailSent: true });
    const row = await updateCredentialing(ACTOR, a.id, { formsReceived: true, npdbCheck: true });

    expect(row.formsReceived).toBe(true);
    expect(row.npdbCheck).toBe(true);
    expect(await prisma.attendingCredentialing.count()).toBe(1);
  });

  // Unticking is a real edit: a stage recorded by mistake has to be reversible.
  it("clears a stage that is unticked", async () => {
    await grantManageAttendings();
    const a = await attending("Rivera");
    await updateCredentialing(ACTOR, a.id, { npdbCheck: true });

    const row = await updateCredentialing(ACTOR, a.id, { npdbCheck: false });
    expect(row.npdbCheck).toBe(false);
  });

  it("leaves a stage alone when it is not in the patch", async () => {
    await grantManageAttendings();
    const a = await attending("Rivera");
    await updateCredentialing(ACTOR, a.id, { npdbCheck: true });

    const row = await updateCredentialing(ACTOR, a.id, { notes: "chasing OAPD" });
    expect(row.npdbCheck).toBe(true);
    expect(row.notes).toBe("chasing OAPD");
  });
});

describe("listCredentialing", () => {
  // Someone with no row has not been started, and hiding them would make the
  // tracker useless for deciding who to pick up next.
  it("includes attendings who have not been started", async () => {
    await grantManageAttendings();
    const started = await attending("Started");
    await attending("Untouched");
    await updateCredentialing(ACTOR, started.id, { infoEmailSent: true });

    const rows = await listCredentialing();

    expect(rows.map((r) => r.scheduleName).sort()).toEqual(["Started", "Untouched"]);
    expect(rows.find((r) => r.scheduleName === "Untouched")?.credentialing).toBeNull();
  });
});

describe("outstandingSteps", () => {
  const base = {
    id: "c",
    attendingId: "a",
    infoEmailSent: false,
    formsReceived: false,
    npdbCheck: false,
    oapd: false,
    needsFtca: false,
    ftcaSubmitted: false,
    medDirectorApprovalNeeded: false,
    medDirectorApproved: false,
    steeringCommitteeApprovalNeeded: false,
    steeringCommitteeApproved: false,
    approved: false,
    notes: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it("lists the core stages still outstanding", () => {
    expect(outstandingSteps(base)).toEqual(["info email", "credentialing form", "NPDB check", "OAPD"]);
  });

  // FTCA is only chased when the attending actually needs the coverage, so an
  // unneeded one must not sit in the list forever.
  it("asks for FTCA only when it is needed", () => {
    expect(outstandingSteps({ ...base, infoEmailSent: true, formsReceived: true, npdbCheck: true, oapd: true })).toEqual([]);
    expect(
      outstandingSteps({
        ...base,
        infoEmailSent: true,
        formsReceived: true,
        npdbCheck: true,
        oapd: true,
        needsFtca: true,
      }),
    ).toEqual(["FTCA"]);
  });

  // The two approval routes are alternatives; only the one marked as needed
  // should appear.
  it("asks for whichever approval route applies", () => {
    const done = { ...base, infoEmailSent: true, formsReceived: true, npdbCheck: true, oapd: true };
    expect(outstandingSteps({ ...done, medDirectorApprovalNeeded: true })).toEqual(["medical director"]);
    expect(outstandingSteps({ ...done, steeringCommitteeApprovalNeeded: true })).toEqual([
      "steering committee",
    ]);
  });

  it("reports nothing once approved, or before tracking starts", () => {
    expect(outstandingSteps({ ...base, approved: true })).toEqual([]);
    expect(outstandingSteps(null)).toEqual([]);
  });
});
