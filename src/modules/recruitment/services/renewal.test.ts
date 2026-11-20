import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { directorRunStart, directorTermIsUp, getRenewalContext, resolveRenewalPrefill, resolveReturningPersonId } from "./renewal";

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

// The fallback branch: a context with no stored parts (an ineligible person, or
// a hand-built ctx) still splits the display name rather than prefilling nothing.
it("resolveRenewalPrefill splits name, locks email and netid, maps phone, skips off-convention keys", async () => {
  const ctx = { personId: "p1", name: "Mary Jane Watson", legalFirstName: null, lastName: null, preferredFirstName: null, email: "mjw@yale.edu", netId: "mjw1", phone: "555", currentDepartments: ["SRHD"], eligible: true };
  const { values, lockedKeys } = resolveRenewalPrefill(
    [{ key: "first_name", type: "SHORT_TEXT" }, { key: "last_name", type: "SHORT_TEXT" }, { key: "email", type: "EMAIL" }, { key: "phone", type: "PHONE" }, { key: "net_id", type: "SHORT_TEXT" }, { key: "favorite_color", type: "SHORT_TEXT" }],
    ctx,
  );
  expect(values.first_name).toBe("Mary");
  // "Jane" is a middle name, not half of the surname. The old split took
  // everything after the first space and put it in the last-name box.
  expect(values.last_name).toBe("Watson");
  expect(values.email).toBe("mjw@yale.edu");
  expect(values.phone).toBe("555");
  expect(values.net_id).toBe("mjw1");
  expect(values.favorite_color).toBeUndefined();
  // A person with an existing record cannot edit their NetID: it is locked like
  // the verified email. Phone stays editable.
  expect(lockedKeys).toEqual(["email", "net_id"]);
});

// The parenthetical form this whole feature exists to retire. On the fallback
// branch it used to prefill the first-name box with "Jonathan (Jack)", which is
// what an applicant then submitted and what an Epic request carried to YNHH.
it("resolveRenewalPrefill reads a parenthetical nickname out of the fallback name", async () => {
  const ctx = {
    personId: "p2",
    name: "Jonathan (Jack) Carney",
    legalFirstName: null,
    lastName: null,
    preferredFirstName: null,
    email: "jc@yale.edu",
    netId: "jc99",
    phone: null,
    currentDepartments: ["SRHD"],
    eligible: true,
  };
  const { values } = resolveRenewalPrefill(
    [
      { key: "first_name", type: "SHORT_TEXT" },
      { key: "last_name", type: "SHORT_TEXT" },
      { key: "preferred_first_name", type: "SHORT_TEXT" },
    ],
    ctx,
  );
  expect(values.first_name).toBe("Jonathan");
  expect(values.last_name).toBe("Carney");
  expect(values.preferred_first_name).toBe("Jack");
});

it("resolveRenewalPrefill does not lock net_id when the record has no NetID", async () => {
  const ctx = { personId: "p1", name: "No Net", legalFirstName: null, lastName: null, preferredFirstName: null, email: "nn@yale.edu", netId: null, phone: null, currentDepartments: ["SRHD"], eligible: true };
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

it("resolveRenewalPrefill reads the stored name parts rather than splitting the display name", () => {
  const ctx = {
    personId: "p1",
    name: "Lupe Zavala",
    legalFirstName: "Guadalupe",
    lastName: "Hernandez Zavala",
    preferredFirstName: "Lupe",
    email: "lz@yale.edu",
    netId: "lz1",
    phone: null,
    currentDepartments: ["SRHD"],
    eligible: true,
  };
  const { values } = resolveRenewalPrefill(
    [
      { key: "first_name", type: "SHORT_TEXT" },
      { key: "last_name", type: "SHORT_TEXT" },
      { key: "preferred_first_name", type: "SHORT_TEXT" },
    ],
    ctx,
  );
  // The compound surname survives, which the first-space split could never do.
  expect(values.first_name).toBe("Guadalupe");
  expect(values.last_name).toBe("Hernandez Zavala");
  expect(values.preferred_first_name).toBe("Lupe");
});

// ---------------------------------------------------------------------------
// Director one-year term: Renew is offered once a director's year is up.
// ---------------------------------------------------------------------------

const SP27_START = new Date("2027-01-11");

async function makeTerm(code: string, start: string) {
  return prisma.term.create({ data: { code, name: code, startDate: new Date(start), endDate: new Date(start) } });
}
async function director(personId: string, termId: string, departmentId: string) {
  await prisma.termMembership.create({ data: { personId, termId, departmentId, kind: "DIRECTOR", status: "ACTIVE" } });
}

it("offers a director renewal once a year has passed since they started", async () => {
  const sp26 = await makeTerm("SP26", "2026-01-12");
  const su26 = await makeTerm("SU26", "2026-05-15");
  const fa26 = await makeTerm("FA26", "2026-08-25");
  const fa25 = await makeTerm("FA25", "2025-08-25");
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "MDIC", name: "MDIC" } });
  const dir = await prisma.person.create({ data: { name: "Dana Director", status: "ACTIVE" } });
  const someoneElse = await prisma.person.create({ data: { name: "Other Director", status: "ACTIVE" } });
  // FA25 has director records, but not Dana in SRHD: that is where her run begins after.
  await director(someoneElse.id, fa25.id, other.id);
  for (const t of [sp26, su26, fa26]) await director(dir.id, t.id, dept.id);

  const ctx = await getRenewalContext(dir.id, "d@yale.edu", "DIRECTOR", SP27_START);
  expect(ctx.currentDepartments).toEqual(["SRHD"]);
  expect(ctx.renewableDepartments).toEqual(["SRHD"]);
  expect(ctx.termNotUp).toEqual([]);
});

it("does not offer renewal to a director whose year is not up, but still allows transfer", async () => {
  const sp26 = await makeTerm("SP26", "2026-01-12");
  const fa26 = await makeTerm("FA26", "2026-08-25");
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "MDIC", name: "MDIC" } });
  const dir = await prisma.person.create({ data: { name: "New Director", status: "ACTIVE" } });
  const someoneElse = await prisma.person.create({ data: { name: "Other Director", status: "ACTIVE" } });
  await director(someoneElse.id, sp26.id, other.id); // SP26 has a board on file without them
  await director(dir.id, fa26.id, dept.id);

  const ctx = await getRenewalContext(dir.id, "n@yale.edu", "DIRECTOR", SP27_START);
  expect(ctx.eligible).toBe(true); // still a current director: TRANSFER stays open
  expect(ctx.currentDepartments).toEqual(["SRHD"]);
  expect(ctx.renewableDepartments).toEqual([]);
  expect(ctx.termNotUp).toEqual([{ department: "SRHD", termUpOn: new Date("2027-08-25") }]);
});

it("treats a director whose run reaches the start of the Hub's records as up for renewal", async () => {
  // Only FA26 is on file: the Hub cannot tell when they started, so missing
  // history must not take Renew away.
  const fa26 = await makeTerm("FA26", "2026-08-25");
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const dir = await prisma.person.create({ data: { name: "Legacy Director", status: "ACTIVE" } });
  await director(dir.id, fa26.id, dept.id);
  const ctx = await getRenewalContext(dir.id, "l@yale.edu", "DIRECTOR", SP27_START);
  expect(ctx.renewableDepartments).toEqual(["SRHD"]);
});

it("steps over past terms that hold no director records at all", async () => {
  // SP26 was imported without its board. That gap is not a break in the run, so
  // the start is unknown and Renew stays offered.
  await makeTerm("SP26", "2026-01-12");
  const fa26 = await makeTerm("FA26", "2026-08-25");
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const dir = await prisma.person.create({ data: { name: "Gap Director", status: "ACTIVE" } });
  await director(dir.id, fa26.id, dept.id);
  const ctx = await getRenewalContext(dir.id, "g@yale.edu", "DIRECTOR", SP27_START);
  expect(ctx.renewableDepartments).toEqual(["SRHD"]);
});

it("leaves volunteer renewals and calls without a cycle term unchanged", async () => {
  const fa26 = await makeTerm("FA26", "2026-08-25");
  const sp26 = await makeTerm("SP26", "2026-01-12");
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "MDIC", name: "MDIC" } });
  const p = await prisma.person.create({ data: { name: "Both", status: "ACTIVE" } });
  const someoneElse = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  await director(someoneElse.id, sp26.id, other.id);
  await director(p.id, fa26.id, dept.id);
  await prisma.termMembership.create({ data: { personId: p.id, termId: fa26.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  expect((await getRenewalContext(p.id, "b@yale.edu", "VOLUNTEER", SP27_START)).renewableDepartments).toEqual(["SRHD"]);
  expect((await getRenewalContext(p.id, "b@yale.edu", "DIRECTOR")).renewableDepartments).toEqual(["SRHD"]);
});

it("directorRunStart and directorTermIsUp", () => {
  const terms = [
    { id: "fa25", startDate: new Date("2025-08-25") },
    { id: "sp26", startDate: new Date("2026-01-12") },
    { id: "fa26", startDate: new Date("2026-08-25") },
  ];
  const all = new Set(["fa25", "sp26", "fa26"]);
  expect(directorRunStart({ terms, termsWithDirectorRecords: all, directedTermIds: new Set(["sp26", "fa26"]), fromTermId: "fa26" }))
    .toEqual(new Date("2026-01-12"));
  expect(directorRunStart({ terms, termsWithDirectorRecords: all, directedTermIds: new Set(["fa25", "sp26", "fa26"]), fromTermId: "fa26" }))
    .toBeNull();
  // Term start dates drift: Spring 2026 Jan 12 -> Spring 2027 Jan 11 still counts.
  expect(directorTermIsUp(new Date("2026-01-12"), new Date("2027-01-11"))).toBe(true);
  // A summer start is not up by the following spring.
  expect(directorTermIsUp(new Date("2026-05-15"), new Date("2027-01-11"))).toBe(false);
  expect(directorTermIsUp(null, new Date("2027-01-11"))).toBe(true);
});
