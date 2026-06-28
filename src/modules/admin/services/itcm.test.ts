import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { authorizerInitials, listEpicAuthorizers, listPendingDeactivations, reconcileDeactivationRequests } from "./itcm";

describe("authorizerInitials", () => {
  it("returns the first and last token initials, uppercased", () => {
    expect(authorizerInitials("Caprice Culkin")).toBe("CC");
    expect(authorizerInitials("Renee Tracey")).toBe("RT");
    expect(authorizerInitials("Jack Carney")).toBe("JC");
  });

  it("uses the first and final token for multi-part names", () => {
    expect(authorizerInitials("Mary Jane Watson")).toBe("MW");
  });

  it("handles a single-token name and stray whitespace", () => {
    expect(authorizerInitials("Cher")).toBe("C");
    expect(authorizerInitials("  Ada   Lovelace  ")).toBe("AL");
    expect(authorizerInitials("")).toBe("");
  });
});

describe("listEpicAuthorizers", () => {
  beforeEach(resetDb);

  async function activeItcm() {
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-06-01"), endDate: new Date("2026-08-31"), status: "ACTIVE" },
    });
    const itcm = await prisma.department.create({ data: { code: "ITCM", name: "IT & Compliance Management" } });
    return { term, itcm };
  }

  it("returns ACTIVE ITCM directors of the active term with name, phone, email, and initials", async () => {
    const { term, itcm } = await activeItcm();
    const cc = await prisma.person.create({
      data: { name: "Caprice Culkin", phone: "720-254-2589", contactEmail: "caprice.culkin@yale.edu" },
    });
    await prisma.termMembership.create({
      data: { personId: cc.id, termId: term.id, departmentId: itcm.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const rows = await listEpicAuthorizers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: cc.id,
      name: "Caprice Culkin",
      phone: "720-254-2589",
      email: "caprice.culkin@yale.edu",
      initials: "CC",
    });
  });

  it("excludes ITCM volunteers and directors of other departments", async () => {
    const { term, itcm } = await activeItcm();
    const exec = await prisma.department.create({ data: { code: "EXEC", name: "Executive Directors" } });
    const vol = await prisma.person.create({ data: { name: "Vol Unteer", contactEmail: "v@yale.edu" } });
    const execDir = await prisma.person.create({ data: { name: "Exec Director", contactEmail: "e@yale.edu" } });
    await prisma.termMembership.create({
      data: { personId: vol.id, termId: term.id, departmentId: itcm.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: execDir.id, termId: term.id, departmentId: exec.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    expect(await listEpicAuthorizers()).toEqual([]);
  });

  it("excludes REMOVED memberships and directors from inactive terms", async () => {
    const { term, itcm } = await activeItcm();
    const oldTerm = await prisma.term.create({
      data: { code: "SP26", name: "Spring 2026", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-31"), status: "ARCHIVED" },
    });
    const removed = await prisma.person.create({ data: { name: "Removed Dir", contactEmail: "r@yale.edu" } });
    const oldDir = await prisma.person.create({ data: { name: "Old Dir", contactEmail: "o@yale.edu" } });
    await prisma.termMembership.create({
      data: { personId: removed.id, termId: term.id, departmentId: itcm.id, kind: "DIRECTOR", status: "REMOVED" },
    });
    await prisma.termMembership.create({
      data: { personId: oldDir.id, termId: oldTerm.id, departmentId: itcm.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    expect(await listEpicAuthorizers()).toEqual([]);
  });

  it("defaults phone and email to empty strings when the person has none", async () => {
    const { term, itcm } = await activeItcm();
    const p = await prisma.person.create({ data: { name: "No Contact" } });
    await prisma.termMembership.create({
      data: { personId: p.id, termId: term.id, departmentId: itcm.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const rows = await listEpicAuthorizers();
    expect(rows[0]).toMatchObject({ name: "No Contact", phone: "", email: "", initials: "NC" });
  });

  it("returns an empty list when there is no active term", async () => {
    expect(await listEpicAuthorizers()).toEqual([]);
  });
});

describe("listPendingDeactivations", () => {
  beforeEach(resetDb);

  it("returns only people with an open PENDING DEACTIVATE request", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const a = await prisma.person.create({ data: { name: "Alice", epicId: "EA", status: "OFFBOARDED" } });
    const b = await prisma.person.create({ data: { name: "Bob", epicId: "EB", status: "OFFBOARDED" } });
    const c = await prisma.person.create({ data: { name: "Carol", epicId: "EC", status: "ACTIVE" } });

    await prisma.epicRequest.create({ data: { personId: a.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id } });
    await prisma.epicRequest.create({ data: { personId: b.id, kind: "DEACTIVATE", status: "COMPLETED", requestedById: actor.id } });
    await prisma.epicRequest.create({ data: { personId: c.id, kind: "NEW", status: "PENDING", requestedById: actor.id } });

    const rows = await listPendingDeactivations();
    expect(rows.map((r) => r.name)).toEqual(["Alice"]);
    expect(rows[0].epicId).toBe("EA");
  });
});

describe("reconcileDeactivationRequests", () => {
  beforeEach(resetDb);

  it("attaches an existing pending DEACTIVATE to the ticket without duplicating, and creates one when missing", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const withReq = await prisma.person.create({ data: { name: "HasReq", epicId: "E1", status: "OFFBOARDED" } });
    const withoutReq = await prisma.person.create({ data: { name: "NoReq", epicId: "E2", status: "OFFBOARDED" } });
    const existing = await prisma.epicRequest.create({
      data: { personId: withReq.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });
    const ticket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });

    await reconcileDeactivationRequests(actor.id, [withReq.id, withoutReq.id], ticket.id);

    const reused = await prisma.epicRequest.findUnique({ where: { id: existing.id } });
    expect(reused?.status).toBe("SUBMITTED");
    expect(reused?.ticketId).toBe(ticket.id);

    const forWithReq = await prisma.epicRequest.findMany({ where: { personId: withReq.id, kind: "DEACTIVATE" } });
    expect(forWithReq).toHaveLength(1); // no duplicate

    const created = await prisma.epicRequest.findMany({ where: { personId: withoutReq.id, kind: "DEACTIVATE" } });
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("SUBMITTED");
    expect(created[0].ticketId).toBe(ticket.id);
  });

  it("reuses an already-SUBMITTED open DEACTIVATE, re-pointing it at the new ticket without duplicating", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const person = await prisma.person.create({ data: { name: "AlreadySubmitted", epicId: "E3", status: "OFFBOARDED" } });
    const oldTicket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });
    const existing = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "DEACTIVATE", status: "SUBMITTED", ticketId: oldTicket.id, requestedById: actor.id },
    });
    const newTicket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });

    await reconcileDeactivationRequests(actor.id, [person.id], newTicket.id);

    const reused = await prisma.epicRequest.findUnique({ where: { id: existing.id } });
    expect(reused?.status).toBe("SUBMITTED");
    expect(reused?.ticketId).toBe(newTicket.id);

    const all = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
    expect(all).toHaveLength(1); // no duplicate
  });
});
