import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listDepartments,
  createDepartment,
  updateDepartment,
  setDelegations,
  DepartmentConflictError,
  DepartmentNotFoundError,
  DepartmentValidationError,
} from "./departments";

beforeEach(resetDb);

describe("createDepartment", () => {
  it("normalizes the code to uppercase and creates", async () => {
    const d = await createDepartment("actor-1", { code: "scts", name: "Surgical Care" });
    expect(d.code).toBe("SCTS");
    expect(d.isActive).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "department.create" } });
    expect(audit).toMatchObject({ entityType: "Department", entityId: d.id });
  });

  it("rejects a duplicate code (case-insensitive)", async () => {
    await createDepartment("a", { code: "PCAR", name: "PCAR" });
    await expect(createDepartment("a", { code: "pcar", name: "again" })).rejects.toBeInstanceOf(
      DepartmentConflictError
    );
  });

  it("rejects a bad code format and an empty name", async () => {
    await expect(createDepartment("a", { code: "a b!", name: "x" })).rejects.toBeInstanceOf(
      DepartmentValidationError
    );
    await expect(createDepartment("a", { code: "OKAY", name: "  " })).rejects.toBeInstanceOf(
      DepartmentValidationError
    );
  });

  it("rejects a non-positive capacity", async () => {
    await expect(
      createDepartment("a", { code: "OKAY", name: "x", idealHeadcount: 0 })
    ).rejects.toBeInstanceOf(DepartmentValidationError);
  });

  it("persists per-track Epic requirements and audits them; defaults both to NONE", async () => {
    const withEpic = await createDepartment("a", {
      code: "PCAR",
      name: "Primary Care",
      requiresEpicDirector: "ALL",
      requiresEpicVolunteer: "SOME",
    });
    expect(withEpic.requiresEpicDirector).toBe("ALL");
    expect(withEpic.requiresEpicVolunteer).toBe("SOME");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "department.create", entityId: withEpic.id },
    });
    expect(audit?.after).toMatchObject({ requiresEpicDirector: "ALL", requiresEpicVolunteer: "SOME" });

    const bare = await createDepartment("a", { code: "CRAD", name: "Community Relations" });
    expect(bare.requiresEpicDirector).toBe("NONE");
    expect(bare.requiresEpicVolunteer).toBe("NONE");
  });
});

describe("updateDepartment", () => {
  it("updates name/active/capacity and audits before/after; does not change code", async () => {
    const d = await createDepartment("a", { code: "ITCM", name: "Old" });
    const u = await updateDepartment("actor-2", d.id, {
      name: "New",
      isActive: false,
      idealHeadcount: 5,
      patientCapacityPerProvider: null,
    });
    expect(u.code).toBe("ITCM");
    expect(u.name).toBe("New");
    expect(u.isActive).toBe(false);
    expect(u.idealHeadcount).toBe(5);
    const audit = await prisma.auditLog.findFirst({ where: { action: "department.update" } });
    expect(audit?.before).toMatchObject({ name: "Old", isActive: true });
    expect(audit?.after).toMatchObject({ name: "New", isActive: false });
  });

  it("updates per-track Epic requirements and audits them before/after", async () => {
    const d = await createDepartment("a", {
      code: "ORHI",
      name: "Oral Health",
      requiresEpicDirector: "ALL",
      requiresEpicVolunteer: "ALL",
    });
    const u = await updateDepartment("a", d.id, {
      name: "Oral Health",
      isActive: true,
      idealHeadcount: null,
      patientCapacityPerProvider: null,
      requiresEpicDirector: "SOME",
      requiresEpicVolunteer: "NONE",
    });
    expect(u.requiresEpicDirector).toBe("SOME");
    expect(u.requiresEpicVolunteer).toBe("NONE");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "department.update", entityId: d.id },
    });
    expect(audit?.before).toMatchObject({ requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL" });
    expect(audit?.after).toMatchObject({ requiresEpicDirector: "SOME", requiresEpicVolunteer: "NONE" });
  });

  it("preserves the existing Epic requirements when an update omits them", async () => {
    const d = await createDepartment("a", {
      code: "ORHI",
      name: "Oral Health",
      requiresEpicDirector: "ALL",
      requiresEpicVolunteer: "SOME",
    });
    const u = await updateDepartment("a", d.id, {
      name: "Renamed",
      isActive: true,
      idealHeadcount: null,
      patientCapacityPerProvider: null,
    });
    expect(u.requiresEpicDirector).toBe("ALL");
    expect(u.requiresEpicVolunteer).toBe("SOME");
  });

  it("throws DepartmentNotFoundError for a missing id", async () => {
    await expect(
      updateDepartment("a", "nope", { name: "x", isActive: true, idealHeadcount: null, patientCapacityPerProvider: null })
    ).rejects.toBeInstanceOf(DepartmentNotFoundError);
  });

  it("rejects an empty name or a non-positive capacity on update", async () => {
    const d = await createDepartment("a", { code: "ITCM", name: "Old" });
    await expect(
      updateDepartment("a", d.id, { name: "  ", isActive: true, idealHeadcount: null, patientCapacityPerProvider: null })
    ).rejects.toBeInstanceOf(DepartmentValidationError);
    await expect(
      updateDepartment("a", d.id, { name: "Ok", isActive: true, idealHeadcount: -2, patientCapacityPerProvider: null })
    ).rejects.toBeInstanceOf(DepartmentValidationError);
  });
});

describe("setDelegations", () => {
  it("replaces the manager's managed set, excluding self and deduping", async () => {
    const pcar = await createDepartment("a", { code: "PCAR", name: "PCAR" });
    const sctp = await createDepartment("a", { code: "SCTP", name: "SCTP" });
    const jctp = await createDepartment("a", { code: "JCTP", name: "JCTP" });

    await setDelegations("actor", pcar.id, [sctp.id, jctp.id, sctp.id, pcar.id]);
    const rows = await prisma.departmentDelegation.findMany({ where: { managerDepartmentId: pcar.id } });
    expect(rows.map((r) => r.managedDepartmentId).sort()).toEqual([jctp.id, sctp.id].sort());

    await setDelegations("actor", pcar.id, [jctp.id]);
    const rows2 = await prisma.departmentDelegation.findMany({ where: { managerDepartmentId: pcar.id } });
    expect(rows2.map((r) => r.managedDepartmentId)).toEqual([jctp.id]);
  });

  it("rejects unknown managed ids", async () => {
    const pcar = await createDepartment("a", { code: "PCAR", name: "PCAR" });
    await expect(setDelegations("a", pcar.id, ["ghost"])).rejects.toBeInstanceOf(DepartmentValidationError);
  });

  it("throws DepartmentNotFoundError when the manager does not exist", async () => {
    await expect(setDelegations("a", "no-manager", [])).rejects.toBeInstanceOf(DepartmentNotFoundError);
  });
});

describe("listDepartments", () => {
  it("returns active first, then by code, with membership counts and managed ids", async () => {
    const a = await createDepartment("a", { code: "AAA", name: "A" });
    const z = await createDepartment("a", { code: "ZZZ", name: "Z" });
    await updateDepartment("a", a.id, { name: "A", isActive: false, idealHeadcount: null, patientCapacityPerProvider: null });
    await setDelegations("a", z.id, [a.id]);

    const list = await listDepartments();
    expect(list[0].code).toBe("ZZZ");
    expect(list[0].managesDelegations.map((m) => m.managedDepartmentId)).toEqual([a.id]);
    expect(list[0]._count).toHaveProperty("memberships");
  });
});
