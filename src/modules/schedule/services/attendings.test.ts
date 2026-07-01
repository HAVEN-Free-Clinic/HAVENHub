import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createAttending,
  updateAttending,
  canManageAnyRhdDept,
  AttendingValidationError,
  AttendingForbiddenError,
} from "./attendings";

const ACTOR = "actor-1";

async function rhdManager() {
  await prisma.person.create({ data: { id: ACTOR, name: "RHD Director" } });
  await prisma.department.upsert({ where: { code: "SCTS" }, update: {}, create: { code: "SCTS", name: "SCTS Dept" } });
  // schedule.edit_all makes every department manageable, including SCTS.
  const role = await prisma.role.create({
    data: { name: `r-${Date.now()}`, isSystem: false, grants: { create: [{ permission: "schedule.edit_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: ACTOR, termId: null } });
}

beforeEach(resetDb);

describe("canManageAnyRhdDept", () => {
  it("is true for someone who manages an RHD-family department", async () => {
    await rhdManager(); // schedule.edit_all + an SCTS department exists
    expect(await canManageAnyRhdDept(ACTOR)).toBe(true);
  });

  it("is false for someone who manages no RHD department", async () => {
    await prisma.person.create({ data: { id: ACTOR, name: "Nobody" } });
    expect(await canManageAnyRhdDept(ACTOR)).toBe(false);
  });
});

describe("createAttending", () => {
  it("creates an attending with capabilities defaulting to unknown", async () => {
    await rhdManager();
    const a = await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    expect(a.scheduleName).toBe("Rivera");
    expect(a.iudIn).toBe("unknown");
    expect(a.isActive).toBe(true);
  });

  it("applies provided capabilities", async () => {
    await rhdManager();
    const a = await createAttending(ACTOR, {
      scheduleName: "Chen",
      fullName: "Dr. Chen",
      capabilities: { iudIn: "yes", gac: "no" },
    });
    expect(a.iudIn).toBe("yes");
    expect(a.gac).toBe("no");
    expect(a.emb).toBe("unknown");
  });

  it("rejects a duplicate scheduleName", async () => {
    await rhdManager();
    await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    await expect(
      createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Other" }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  it("rejects an invalid capability value", async () => {
    await rhdManager();
    await expect(
      createAttending(ACTOR, { scheduleName: "X", fullName: "Y", capabilities: { iudIn: "maybe" as never } }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  it("rejects an actor who manages no RHD department", async () => {
    await prisma.person.create({ data: { id: ACTOR, name: "Nobody" } });
    await expect(
      createAttending(ACTOR, { scheduleName: "Z", fullName: "Z" }),
    ).rejects.toBeInstanceOf(AttendingForbiddenError);
  });
});

describe("updateAttending", () => {
  it("patches only provided fields", async () => {
    await rhdManager();
    const a = await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    const u = await updateAttending(ACTOR, a.id, { capabilities: { iudIn: "yes" }, notes: "fast" });
    expect(u.iudIn).toBe("yes");
    expect(u.notes).toBe("fast");
    expect(u.scheduleName).toBe("Rivera");
  });

  it("rejects renaming to an existing scheduleName", async () => {
    await rhdManager();
    await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    const b = await createAttending(ACTOR, { scheduleName: "Chen", fullName: "Dr. Chen" });
    await expect(
      updateAttending(ACTOR, b.id, { scheduleName: "Rivera" }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });
});

