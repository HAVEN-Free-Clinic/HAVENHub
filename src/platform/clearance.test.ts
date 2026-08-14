/**
 * loadClearedSet: the batched "who is cleared right now" lookup behind the
 * verified badge.
 *
 * The badge renders next to names on pages all over the app, so the ONE thing
 * this must never become is a per-name query. loadClearanceMap costs roughly a
 * dozen queries per call; this resolves the active term itself and calls it once
 * for a whole page's worth of people, returning only the ids that came back
 * cleared.
 *
 * It deliberately answers a narrower question than loadClearanceMap: callers get
 * a Set, not per-task detail, because a badge has nothing to say about WHICH
 * task is outstanding. Anything wanting that detail should use the roster.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { loadClearedSet } from "./clearance";

beforeEach(resetDb);

async function activeTerm() {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
}

async function memberWithProfile(name: string, deptId: string, termId: string) {
  const person = await prisma.person.create({
    data: { name, status: "ACTIVE", contactEmail: `${name}@x.edu`, phone: "555-0100" },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId: deptId, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return person;
}

async function validCert(personId: string) {
  await prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: `c-${personId}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: new Date(),
      verifiedAt: new Date(),
      uploadedAt: new Date(),
    },
  });
}

describe("loadClearedSet", () => {
  it("returns only the cleared people", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const cleared = await memberWithProfile("Ada", dept.id, term.id);
    const notCleared = await memberWithProfile("Bob", dept.id, term.id);
    await validCert(cleared.id);
    // Bob has no HIPAA certificate, so the blocking hipaa step keeps him out.

    const set = await loadClearedSet([cleared.id, notCleared.id]);

    expect(set.has(cleared.id)).toBe(true);
    expect(set.has(notCleared.id)).toBe(false);
  });

  it("returns an empty set for no input, without needing a term", async () => {
    expect((await loadClearedSet([])).size).toBe(0);
  });

  it("returns an empty set when there is no active term", async () => {
    // Clearance is defined per term. With no active term nobody is cleared FOR
    // anything, and the badge must simply not render rather than guess against
    // a stale or future term.
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const archived = await prisma.term.create({
      data: {
        code: "SP26",
        name: "Spring 2026",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-04-30"),
        status: "ARCHIVED",
      },
    });
    const person = await memberWithProfile("Ada", dept.id, archived.id);
    await validCert(person.id);

    expect((await loadClearedSet([person.id])).size).toBe(0);
  });

  it("omits a person with no membership in the active term", async () => {
    // An alum or a not-yet-onboarded person is not "not cleared" so much as not
    // in scope. Either way the badge stays off.
    await activeTerm();
    const outsider = await prisma.person.create({
      data: { name: "Cleo", status: "ACTIVE", contactEmail: "c@x.edu", phone: "555-0100" },
    });
    await validCert(outsider.id);

    expect((await loadClearedSet([outsider.id])).has(outsider.id)).toBe(false);
  });
});
