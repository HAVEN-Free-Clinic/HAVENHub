import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { loadTermEpicRollup } from "./epic-rollup";
import { SupportNotFoundError } from "./tech-request";

async function makeTerm(code: string, startYear: number) {
  return prisma.term.create({
    data: {
      code,
      name: code,
      startDate: new Date(`${startYear}-01-01T00:00:00Z`),
      endDate: new Date(`${startYear}-06-01T00:00:00Z`),
      status: "ACTIVE",
    },
  });
}

async function makeDept(code: string, requiresEpicVolunteer: "ALL" | "SOME" | "NONE") {
  return prisma.department.create({
    data: { code, name: code, requiresEpicVolunteer, requiresEpicDirector: "NONE" },
  });
}

async function makePerson(name: string, opts: { epicId?: string; status?: "ACTIVE" | "OFFBOARDED" } = {}) {
  return prisma.person.create({
    data: { name, epicId: opts.epicId ?? null, status: opts.status ?? "ACTIVE" },
  });
}

async function join(personId: string, termId: string, departmentId: string) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind: "VOLUNTEER", status: "ACTIVE" },
  });
}

beforeEach(resetDb);

describe("loadTermEpicRollup", () => {
  it("throws when the term does not exist", async () => {
    await expect(loadTermEpicRollup("no-such-term")).rejects.toBeInstanceOf(SupportNotFoundError);
  });

  it("omits members whose departments never require Epic", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("NOEPIC", "NONE");
    const p = await makePerson("Nora");
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW).toHaveLength(0);
    expect(rollup.groups.MODIFY).toHaveLength(0);
    expect(rollup.groups.RENEW).toHaveLength(0);
  });

  it("puts a first-time member with no Epic ID in NEW", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Ada");
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW.map((r) => r.name)).toEqual(["Ada"]);
    expect(rollup.groups.NEW[0].kindSource).toBe("derived");
    expect(rollup.groups.NEW[0].optional).toBe(false);
    expect(rollup.groups.NEW[0].selectable).toBe(true);
  });

  it("puts a returning member in the same department in RENEW", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Fay", { epicId: "E-FAY" });
    await join(p.id, prior.id, dept.id);
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.RENEW.map((r) => r.name)).toEqual(["Fay"]);
  });

  it("puts a returning member who changed department in MODIFY", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const from = await makeDept("SCTP", "ALL");
    const to = await makeDept("JCTP", "ALL");
    const p = await makePerson("Eli", { epicId: "E-ELI" });
    await join(p.id, prior.id, from.id);
    await join(p.id, term.id, to.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.MODIFY.map((r) => r.name)).toEqual(["Eli"]);
    expect(rollup.groups.MODIFY[0].priorDepartmentNames).toEqual(["SCTP"]);
  });

  it("resolves the prior term as the most recent one, not the oldest", async () => {
    const oldest = await makeTerm("FA24", 2024);
    const recent = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const a = await makeDept("AAA", "ALL");
    const b = await makeDept("BBB", "ALL");
    const p = await makePerson("Gil", { epicId: "E-GIL" });
    await join(p.id, oldest.id, b.id);   // long ago: department B
    await join(p.id, recent.id, a.id);   // most recent prior: department A
    await join(p.id, term.id, a.id);     // this term: department A, unchanged

    const rollup = await loadTermEpicRollup(term.id);
    // Compared against FA25 (A -> A) this is a RENEW. Compared against FA24 it
    // would wrongly be a MODIFY.
    expect(rollup.groups.RENEW.map((r) => r.name)).toEqual(["Gil"]);
  });

  it("accumulates every department from the most recent prior term, not just one", async () => {
    const older = await makeTerm("FA24", 2024);
    const recentPrior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const deptA = await makeDept("AAA", "ALL");
    const deptB = await makeDept("BBB", "ALL");
    const deptC = await makeDept("CCC", "ALL");
    const p = await makePerson("Rae", { epicId: "E-RAE" });
    await join(p.id, older.id, deptC.id); // older prior term: department C
    await join(p.id, recentPrior.id, deptA.id); // most recent prior: department A
    await join(p.id, recentPrior.id, deptB.id); // most recent prior: department B (same term as A)
    await join(p.id, term.id, deptA.id); // this term: only department A

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.MODIFY.map((r) => r.name)).toEqual(["Rae"]);
    expect(rollup.groups.MODIFY[0].priorDepartmentNames).toContain("AAA");
    expect(rollup.groups.MODIFY[0].priorDepartmentNames).toContain("BBB");
    expect(rollup.groups.MODIFY[0].priorDepartmentNames).not.toContain("CCC");
  });

  it("marks a SOME-department member with no signal as optional in NEW", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("MAYBE", "SOME");
    const p = await makePerson("Cyd");
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW).toHaveLength(1);
    expect(rollup.groups.NEW[0].optional).toBe(true);
  });

  it("lets a ticket-origin request override the derived kind", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Dee", { epicId: "E-DEE" });
    const actor = await makePerson("Manager");
    await join(p.id, prior.id, dept.id);
    await join(p.id, term.id, dept.id); // derived kind would be RENEW

    const ticket = await prisma.techRequest.create({
      data: {
        requesterId: p.id, category: "EPIC", subject: "Access change",
        description: "New role", status: "SUBMITTED",
      },
    });
    await prisma.epicRequest.create({
      data: {
        personId: p.id, kind: "MODIFY", status: "PENDING",
        requestedById: actor.id, techRequestId: ticket.id,
      },
    });

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.RENEW).toHaveLength(0);
    expect(rollup.groups.MODIFY).toHaveLength(1);
    expect(rollup.groups.MODIFY[0].kindSource).toBe("ticket");
    expect(rollup.groups.MODIFY[0].existingRequest?.techRequestNumber).toBe(ticket.number);
  });

  it("prefers a ticket-origin request over an older non-ticket request when picking the grant-side row", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Jan", { epicId: "E-JAN" });
    const actor = await makePerson("Manager");
    await join(p.id, prior.id, dept.id);
    await join(p.id, term.id, dept.id); // derived kind would be RENEW

    // Older, non-ticket, open grant-side request. Under a naive "oldest open
    // request wins" selection this would be picked instead of the ticket-origin
    // request below, hiding that a human is already working a ticket.
    await prisma.epicRequest.create({
      data: {
        personId: p.id, kind: "NEW", status: "PENDING",
        requestedById: actor.id,
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    });

    const ticket = await prisma.techRequest.create({
      data: {
        requesterId: p.id, category: "EPIC", subject: "Access change",
        description: "New role", status: "SUBMITTED",
      },
    });
    const ticketRequest = await prisma.epicRequest.create({
      data: {
        personId: p.id, kind: "MODIFY", status: "PENDING",
        requestedById: actor.id, techRequestId: ticket.id,
        createdAt: new Date("2025-06-01T00:00:00Z"),
      },
    });

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW).toHaveLength(0);
    expect(rollup.groups.RENEW).toHaveLength(0);
    expect(rollup.groups.MODIFY).toHaveLength(1);
    expect(rollup.groups.MODIFY[0].kindSource).toBe("ticket");
    expect(rollup.groups.MODIFY[0].existingRequest?.id).toBe(ticketRequest.id);
    expect(rollup.groups.MODIFY[0].existingRequest?.techRequestNumber).toBe(ticket.number);
  });

  it("marks a person with a submitted request as not selectable", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Ben");
    const actor = await makePerson("Manager");
    const ynhh = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, status: "OPEN" },
    });
    await join(p.id, term.id, dept.id);
    await prisma.epicRequest.create({
      data: {
        personId: p.id, kind: "NEW", status: "SUBMITTED",
        requestedById: actor.id, ticketId: ynhh.id,
      },
    });

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW).toHaveLength(1);
    expect(rollup.groups.NEW[0].selectable).toBe(false);
    expect(rollup.groups.NEW[0].existingRequest?.status).toBe("SUBMITTED");
  });

  it("blocks a person with an open deactivation request", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Hal", { epicId: "E-HAL" });
    const actor = await makePerson("Manager");
    await join(p.id, term.id, dept.id);
    await prisma.epicRequest.create({
      data: { personId: p.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });

    const rollup = await loadTermEpicRollup(term.id);
    const row = rollup.groups.MODIFY[0];
    expect(row.selectable).toBe(false);
    expect(row.blockedReason).toContain("deactivation");
  });

  it("blocks a row whose open PENDING request has a different kind than the derived group", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Wes", { epicId: "E-WES" });
    const actor = await makePerson("Manager");
    await join(p.id, prior.id, dept.id);
    await join(p.id, term.id, dept.id); // same department both terms: derived kind is RENEW

    // A stale promotion-origin NEW request nobody completed (no techRequestId, so
    // it does not override the derived kind via kindSource === "ticket").
    await prisma.epicRequest.create({
      data: { personId: p.id, kind: "NEW", status: "PENDING", requestedById: actor.id },
    });

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.RENEW).toHaveLength(1);
    const row = rollup.groups.RENEW[0];
    expect(row.name).toBe("Wes");
    expect(row.selectable).toBe(false);
    expect(row.blockedReason).toContain("open new request");
  });

  it("reports the missing onboarding steps for an uncleared member", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Ivy"); // no contactEmail or phone: profile step incomplete
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    const row = rollup.groups.NEW[0];
    expect(row.cleared).toBe(false);
    expect(row.missingLabels).toContain("Profile & agreements");
    // Warn only: an uncleared person is still selectable.
    expect(row.selectable).toBe(true);
  });
});
