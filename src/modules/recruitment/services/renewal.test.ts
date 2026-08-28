import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getRenewalContext, resolveRenewalPrefill, resolveReturningPersonId } from "./renewal";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function volunteerIn(deptCode: string, termCode: string, termStart: Date, kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER", status: "ACTIVE" | "REMOVED" = "ACTIVE") {
  const person = await prisma.person.create({ data: { name: "Reed Renew", netId: "rr99", phone: "203-555-0100", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: termCode, name: termCode, startDate: termStart, endDate: termStart } });
  const dept = await prisma.department.create({ data: { code: deptCode, name: deptCode } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind, status } });
  return person;
}

it("is eligible with an active volunteer membership and returns its department", async () => {
  const person = await volunteerIn("SRHD", "FA25", new Date("2025-08-01"));
  const ctx = await getRenewalContext(person.id, "reed@yale.edu", "VOLUNTEER");
  expect(ctx.eligible).toBe(true);
  expect(ctx.currentDepartments).toEqual(["SRHD"]);
  expect(ctx.email).toBe("reed@yale.edu"); // session email, verbatim
  expect(ctx.name).toBe("Reed Renew");
  expect(ctx.netId).toBe("rr99");
  expect(ctx.phone).toBe("203-555-0100");
});

it("is not eligible without an active volunteer membership", async () => {
  const person = await prisma.person.create({ data: { name: "No Member", status: "ACTIVE" } });
  const ctx = await getRenewalContext(person.id, "no@yale.edu", "VOLUNTEER");
  expect(ctx.eligible).toBe(false);
  expect(ctx.currentDepartments).toEqual([]);
});

it("filters memberships by the requested kind and ignores REMOVED", async () => {
  // A director is eligible on a DIRECTOR cycle but not on a VOLUNTEER cycle.
  const dir = await volunteerIn("EXEC", "FA25", new Date("2025-08-01"), "DIRECTOR");
  expect((await getRenewalContext(dir.id, "d@yale.edu", "VOLUNTEER")).eligible).toBe(false);
  const dirCtx = await getRenewalContext(dir.id, "d@yale.edu", "DIRECTOR");
  expect(dirCtx.eligible).toBe(true);
  expect(dirCtx.currentDepartments).toEqual(["EXEC"]);
  await resetDb();
  const removed = await volunteerIn("SRHD", "FA25", new Date("2025-08-01"), "VOLUNTEER", "REMOVED");
  expect((await getRenewalContext(removed.id, "r@yale.edu", "VOLUNTEER")).eligible).toBe(false);
});

it("returns currentDepartments from the most-recent term only when memberships span two terms", async () => {
  const person = await prisma.person.create({ data: { name: "Multi Term", status: "ACTIVE" } });
  const termOld = await prisma.term.create({ data: { code: "FA24", name: "FA24", startDate: new Date("2024-08-01"), endDate: new Date("2024-08-01") } });
  const termNew = await prisma.term.create({ data: { code: "FA25", name: "FA25", startDate: new Date("2025-08-01"), endDate: new Date("2025-08-01") } });
  const deptSrhd = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const deptExec = await prisma.department.create({ data: { code: "EXEC", name: "EXEC" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: termOld.id, departmentId: deptSrhd.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: termNew.id, departmentId: deptExec.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const ctx = await getRenewalContext(person.id, "mt@yale.edu", "VOLUNTEER");
  expect(ctx.eligible).toBe(true);
  expect(ctx.currentDepartments).toEqual(["EXEC"]);
});

it("resolveRenewalPrefill splits name, locks email and netid, maps phone, skips off-convention keys", async () => {
  const ctx = { personId: "p1", name: "Mary Jane Watson", email: "mjw@yale.edu", netId: "mjw1", phone: "555", currentDepartments: ["SRHD"], eligible: true };
  const { values, lockedKeys } = resolveRenewalPrefill(
    [{ key: "first_name", type: "SHORT_TEXT" }, { key: "last_name", type: "SHORT_TEXT" }, { key: "email", type: "EMAIL" }, { key: "phone", type: "PHONE" }, { key: "net_id", type: "SHORT_TEXT" }, { key: "favorite_color", type: "SHORT_TEXT" }],
    ctx,
  );
  expect(values.first_name).toBe("Mary");
  expect(values.last_name).toBe("Jane Watson");
  expect(values.email).toBe("mjw@yale.edu");
  expect(values.phone).toBe("555");
  expect(values.net_id).toBe("mjw1");
  expect(values.favorite_color).toBeUndefined();
  // A person with an existing record cannot edit their NetID: it is locked like
  // the verified email. Phone stays editable.
  expect(lockedKeys).toEqual(["email", "net_id"]);
});

it("resolveRenewalPrefill does not lock net_id when the record has no NetID", async () => {
  const ctx = { personId: "p1", name: "No Net", email: "nn@yale.edu", netId: null, phone: null, currentDepartments: ["SRHD"], eligible: true };
  const { values, lockedKeys } = resolveRenewalPrefill([{ key: "net_id", type: "SHORT_TEXT" }, { key: "email", type: "EMAIL" }], ctx);
  expect(values.net_id).toBeUndefined();
  expect(lockedKeys).not.toContain("net_id");
});

// ---------------------------------------------------------------------------
// resolveReturningPersonId
//
// The regression these cover: offboarding at a term flip leaves TermMembership
// ACTIVE but flips Person.status, and auth.ts refuses to sign in an OFFBOARDED
// Person. The whole returning branch hung off the session's personId, so the
// spring cohort applying in the fall (continuous service, summer excepted --
// which the clinic counts as returning) was silently demoted to new applicants.
// ---------------------------------------------------------------------------

/** A member offboarded at the term flip: membership intact, hub access gone. */
async function offboardedAlum(opts: { netId?: string | null; contactEmail?: string | null } = {}) {
  const person = await prisma.person.create({
    data: {
      name: "Alum Spring",
      netId: opts.netId === undefined ? "as88" : opts.netId,
      contactEmail: opts.contactEmail === undefined ? "alum.spring@yale.edu" : opts.contactEmail,
      status: "OFFBOARDED",
    },
  });
  const term = await prisma.term.create({ data: { code: "SP26", name: "SP26", startDate: new Date("2026-01-12"), endDate: new Date("2026-05-29") } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  return person;
}

it("returns the session person unchanged, without consulting the claim", async () => {
  const person = await volunteerIn("SRHD", "FA25", new Date("2025-08-01"));
  // A claim naming nobody must not override a session that already names someone.
  expect(await resolveReturningPersonId(person.id, { upn: "nobody@yale.edu", email: "nobody@yale.edu" })).toBe(person.id);
  expect(await resolveReturningPersonId(person.id, null)).toBe(person.id);
});

it("finds an offboarded alum by the alias-style email claim, so their renewal branch survives the term flip", async () => {
  const person = await offboardedAlum();
  // The shape 252 of the 253 blocked people are stored in: an alias contactEmail
  // that the NetID branch cannot reach.
  expect(await resolveReturningPersonId(null, { upn: null, email: "alum.spring@yale.edu" })).toBe(person.id);
  // And their membership still answers the eligibility question the session could not.
  const ctx = await getRenewalContext(person.id, "alum.spring@yale.edu", "VOLUNTEER");
  expect(ctx.eligible).toBe(true);
  expect(ctx.currentDepartments).toEqual(["SRHD"]);
});

it("finds an offboarded alum by the NetID-shaped UPN when the stored email is personal", async () => {
  // The other half of why both claims are passed: Yale sends the UPN as
  // "netid@yale.edu" and the email claim as the alias, and a Person may be stored
  // under either (or under a personal address the email branch must never match).
  const person = await offboardedAlum({ contactEmail: "alum@gmail.com" });
  expect(await resolveReturningPersonId(null, { upn: "as88@yale.edu", email: "alum.spring@yale.edu" })).toBe(person.id);
});

it("resolves nobody without an SSO claim, so the magic-link cookie cannot stand in for Yale sign-in", async () => {
  // SECURITY. Any @yale.edu address can request a portal magic link, so mailbox
  // possession must not reach a membership record. The caller passes null for
  // every non-SSO path and gets the pre-existing "sign in with Yale" gate.
  await offboardedAlum();
  expect(await resolveReturningPersonId(null, null)).toBeNull();
  expect(await resolveReturningPersonId(undefined, { upn: null, email: null })).toBeNull();
});

it("never matches a stored personal address from a non-Yale claim", async () => {
  // matchPersonByClaim's trust gate, asserted here because this path is the one
  // that turns a claim into someone's membership history.
  await offboardedAlum({ netId: null, contactEmail: "alum@gmail.com" });
  expect(await resolveReturningPersonId(null, { upn: "alum@gmail.com", email: "alum@gmail.com" })).toBeNull();
});
