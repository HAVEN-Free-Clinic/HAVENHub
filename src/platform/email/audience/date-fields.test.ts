import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { dateField } from "./person-fields";
import { resolveAudience } from "./resolve";
import type { Audience } from "./types";

beforeEach(resetDb);

const NOW = new Date("2026-03-15T18:00:00.000Z");

function audienceFor(field: string, op: string, value: string | string[]): Audience {
  return {
    recordType: "PERSON",
    match: "ALL",
    conditions: [{ field, op: op as never, value }],
  };
}

async function personWithCert(name: string, email: string, completionDate: Date | null) {
  const p = await prisma.person.create({
    data: { name, contactEmail: email, status: "ACTIVE" },
  });
  await prisma.hipaaCertificate.create({
    data: {
      personId: p.id,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate,
    },
  });
  return p;
}

describe("compliance and training date fields", () => {
  it("finds certificates completed within a relative window", async () => {
    await personWithCert("Recent", "recent@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Old", "old@x.com", new Date("2025-01-01T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "withinLastDays", "7"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["recent@x.com"]);
  });

  it("finds certificates before an absolute date", async () => {
    await personWithCert("Recent", "recent@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Old", "old@x.com", new Date("2025-01-01T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "before", "2026-01-01"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["old@x.com"]);
  });

  it("excludes a person whose certificate has a null date under isNotEmpty", async () => {
    await personWithCert("Dated", "dated@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Undated", "undated@x.com", null);

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "isNotEmpty", ""),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["dated@x.com"]);
  });

  it("matches on joinedAt, a plain Person column", async () => {
    const old = await prisma.person.create({
      data: { name: "Founder", contactEmail: "founder@x.com", status: "ACTIVE" },
    });
    await prisma.person.update({
      where: { id: old.id },
      data: { createdAt: new Date("2024-01-01T12:00:00.000Z") },
    });
    await prisma.person.create({
      data: { name: "New", contactEmail: "new@x.com", status: "ACTIVE" },
    });

    const { recipients } = await resolveAudience(
      audienceFor("joinedAt", "before", "2025-01-01"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["founder@x.com"]);
  });

  // `some` never matches a person with zero rows, which is why the helper
  // emits none-or-null instead. Without this test that branch is unguarded,
  // and a regression would drop the people a compliance reminder is FOR.
  it("isEmpty matches people with no related row at all, not just a null date", async () => {
    await personWithCert("Undated", "undated@x.com", null);
    await prisma.person.create({
      data: { name: "No Cert", contactEmail: "nocert@x.com", status: "ACTIVE" },
    });
    await personWithCert("Dated", "dated@x.com", new Date("2026-03-12T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "isEmpty", ""),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email).sort()).toEqual(["nocert@x.com", "undated@x.com"]);
  });

  // Person has TWO relations to EhsCompletion: the person's own (ehsCompletions)
  // and the reverse "who marked it" side (ehsCompletionsMarked). Swapping to the
  // reverse relation would compile and typecheck fine while silently changing
  // the send list from "people who completed the training" to "staff who
  // recorded it for someone else" -- so this fixture deliberately puts the
  // completion and the marking on two DIFFERENT people.
  it("ehsCompletedAt matches the person who completed the training, not who marked it", async () => {
    const training = await prisma.ehsTraining.create({ data: { name: "Bloodborne Pathogens" } });
    const completer = await prisma.person.create({
      data: { name: "Completer", contactEmail: "completer@x.com", status: "ACTIVE" },
    });
    const marker = await prisma.person.create({
      data: { name: "Marker", contactEmail: "marker@x.com", status: "ACTIVE" },
    });
    await prisma.ehsCompletion.create({
      data: {
        personId: completer.id,
        trainingId: training.id,
        completedAt: new Date("2026-03-12T12:00:00.000Z"),
        markedById: marker.id,
      },
    });

    const { recipients } = await resolveAudience(
      audienceFor("ehsCompletedAt", "withinLastDays", "7"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["completer@x.com"]);
  });

  // Same trap as above, on Training's reverse relation: trainings (the
  // person-owned side) vs trainingAttendanceMarked (who recorded attendance).
  it("trainingCompletedAt matches the person who completed the training, not who recorded attendance", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SP26",
        name: "Spring 2026",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-05-01"),
        status: "ACTIVE",
      },
    });
    const recorder = await prisma.person.create({
      data: { name: "Recorder", contactEmail: "recorder@x.com", status: "ACTIVE" },
    });
    const cycle = await prisma.recruitmentCycle.create({
      data: {
        track: "VOLUNTEER",
        termId: term.id,
        title: "T",
        publicSlug: "t-cycle-trap",
        departments: [],
        createdById: recorder.id,
      },
    });
    const completer = await prisma.person.create({
      data: { name: "Completer", contactEmail: "trainee@x.com", status: "ACTIVE" },
    });
    await prisma.training.create({
      data: {
        personId: completer.id,
        termId: term.id,
        cycleId: cycle.id,
        status: "COMPLETE",
        completedVia: "QUIZ",
        completedAt: new Date("2026-03-12T12:00:00.000Z"),
        attendanceRecordedById: recorder.id,
        attendanceRecordedAt: new Date("2026-03-12T12:00:00.000Z"),
      },
    });

    const { recipients } = await resolveAudience(
      audienceFor("trainingCompletedAt", "withinLastDays", "7"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["trainee@x.com"]);
  });
});

// Defect 1.3, proved against real SQL rather than against a compiled shape.
//
// A reversed date range is empty either way, but under a NONE group -- which
// compileGroup renders as `NOT { OR: fragments }` -- HOW it is empty decides
// the answer for rows whose column is NULL:
//
//   MATCH_NOBODY sentinel  ->  NOT 1=0                      -> every row
//   empty gte/lt pair      ->  NOT (col >= X AND col < Y)   -> NULL for a NULL
//                                                              column, so NOT
//                                                              TRUE: dropped
//
// No date field in PERSON_FIELDS is exposed to this today: `joinedAt` is
// Person.createdAt, which is NOT NULL; the four relation date fields compile
// through `NOT EXISTS (...)`, which is false (not NULL) for a person with no
// matching row; and `hipaaExpiresAt` resolves through mappedDateWhere, which
// already returns the sentinel. But `dateField`'s `nullable` parameter DEFAULTS
// to true, so the next nullable date column anybody registers walks straight
// into it. This test registers exactly that shape against a real nullable
// Person column and executes the query, so the guarantee is checked rather than
// reasoned about.
describe("an empty date range inside a NONE group, on a NULLABLE column", () => {
  it("keeps the rows whose date is NULL instead of silently dropping them", async () => {
    const neverLoggedIn = await prisma.person.create({
      data: { name: "Never logged in", status: "ACTIVE", lastLoginAt: null },
    });
    const loggedIn = await prisma.person.create({
      data: { name: "Logged in", status: "ACTIVE", lastLoginAt: new Date("2020-01-01T00:00:00.000Z") },
    });

    // nullable defaults to true, exactly as a future registration would.
    const field = dateField("lastLoginAt", "Last login", "Identity", "lastLoginAt");
    const fragment = field.compile(
      { field: "lastLoginAt", op: "between", value: ["2026-03-20", "2026-03-18"] },
      { activeTermId: null, now: NOW, zone: "America/New_York" },
    );

    // The NONE group's shape, applied directly so the assertion is about the
    // SQL Postgres runs and not about the object compileGroup builds.
    const rows = await prisma.person.findMany({
      where: { NOT: { OR: [fragment] } },
      select: { id: true },
    });

    expect(rows.map((r) => r.id).sort()).toEqual([neverLoggedIn.id, loggedIn.id].sort());
  });
});

const DAY = 24 * 60 * 60 * 1000;

/** Creates a cert with explicit uploadedAt/verifiedAt control, for exercising
 *  the newest-vs-effective certificate selection. */
async function certWith(
  personId: string,
  completionDate: Date | null,
  uploadedAt: Date,
  verifiedAt: Date | null,
) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate,
      uploadedAt,
      verifiedAt,
    },
  });
}

// The headline use case Part A's whole-branch review found missing: "certificates
// expiring in the next N days", expressed directly rather than by ANDing
// hipaaCompletedAt withinLastDays 365 against a NONE group.
describe("hipaaExpiresAt (derived from completionDate + CERT_VALIDITY_DAYS)", () => {
  it("matches a certificate expiring INSIDE a withinNextDays window and excludes one OUTSIDE it", async () => {
    // Expires NOW + 20 days -> inside a 30-day window.
    await personWithCert("Soon", "soon@x.com", new Date(NOW.getTime() - 345 * DAY));
    // Expires NOW + 165 days -> outside a 30-day window.
    await personWithCert("Later", "later@x.com", new Date(NOW.getTime() - 200 * DAY));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaExpiresAt", "withinNextDays", "30"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["soon@x.com"]);
  });

  // A person with no certificate at all has no computable expiry (null), and a
  // null value satisfies no comparison operator -- the same reading a NULL
  // column gets against gte/lt/lte. They are reachable only through isEmpty,
  // exactly like hipaaCompletedAt's own null-date behavior above.
  it("excludes a person with no certificate at all from a withinNextDays window", async () => {
    await personWithCert("Soon", "soon@x.com", new Date(NOW.getTime() - 345 * DAY));
    await prisma.person.create({
      data: { name: "No Cert", contactEmail: "nocert@x.com", status: "ACTIVE" },
    });

    const { recipients } = await resolveAudience(
      audienceFor("hipaaExpiresAt", "withinNextDays", "30"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["soon@x.com"]);
  });

  it("isEmpty matches a person with no certificate at all", async () => {
    await personWithCert("Soon", "soon@x.com", new Date(NOW.getTime() - 345 * DAY));
    await prisma.person.create({
      data: { name: "No Cert", contactEmail: "nocert@x.com", status: "ACTIVE" },
    });

    const { recipients } = await resolveAudience(audienceFor("hipaaExpiresAt", "isEmpty", ""), {
      now: NOW,
    });
    expect(recipients.map((r) => r.email)).toEqual(["nocert@x.com"]);
  });

  // The trap this field exists to avoid: the newest cert (by uploadedAt) is an
  // unverified early renewal, so complianceStatus falls back to the older
  // still-valid VERIFIED cert. hipaaExpiresAt must select the SAME certificate,
  // or a "certificates expiring soon" campaign would target a different person
  // than the compliance page shows as expiring soon for identical data.
  //
  // Older verified cert expires NOW + 25 days (inside a 30-day window).
  // Newest unverified cert expires NOW + 360 days (outside it). Selecting the
  // newest cert instead of the effective one would flip this test's answer.
  it("resolves the effective certificate the same way complianceStatus does: an unverified newest renewal defers to the older still-valid VERIFIED cert", async () => {
    const p = await prisma.person.create({
      data: { name: "Renewing", contactEmail: "renewing@x.com", status: "ACTIVE" },
    });
    await certWith(
      p.id,
      new Date(NOW.getTime() - 340 * DAY), // expires NOW+25d
      new Date(NOW.getTime() - 50 * DAY),
      new Date(NOW.getTime() - 50 * DAY), // verified
    );
    await certWith(
      p.id,
      new Date(NOW.getTime() - 5 * DAY), // expires NOW+360d
      new Date(NOW.getTime() - 1 * DAY), // newest by uploadedAt
      null, // unverified early renewal
    );

    const { recipients } = await resolveAudience(
      audienceFor("hipaaExpiresAt", "withinNextDays", "30"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["renewing@x.com"]);
  });
});
