import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setPersonStatusField } from "@/platform/people";
import { getCredential, issueServiceCredential } from "./credential";
import { computeServiceRecord } from "./service-record";

// Partial mock: keeps the real issueServiceCredential by default (every other
// test here relies on it actually running), but lets a single test force it
// to reject, to exercise setPersonStatusField's best-effort try/catch around
// the offboard snapshot (the transaction-poisoning hazard fixed in review
// round 1: the snapshot must run on the singleton client, outside the offboard
// transaction, so a failure here can never abort the membership flip).
vi.mock("@/modules/passport/services/credential", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credential")>();
  return { ...actual, issueServiceCredential: vi.fn(actual.issueServiceCredential) };
});

const ACTOR = "actor-person-id";

async function seedActiveMember() {
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
      endDate: new Date("2026-08-31T12:00:00Z"),
      status: "ACTIVE",
    },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" },
  });
  return person;
}

describe("offboarding snapshots the service record first", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("captures the current term before the membership is flipped to REMOVED", async () => {
    const person = await seedActiveMember();

    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");

    // The membership really was removed ...
    const memberships = await prisma.termMembership.findMany({ where: { personId: person.id } });
    expect(memberships.every((m) => m.status === "REMOVED")).toBe(true);

    // ... and a live recomputation would now show nothing ...
    const live = await computeServiceRecord(person.id);
    expect(live.terms).toHaveLength(0);

    // ... but the snapshot taken during offboarding still has the final term.
    const credential = await getCredential(person.id);
    expect(credential!.record.terms).toHaveLength(1);
    expect(credential!.record.terms[0].termCode).toBe("SU26");
  });

  it("keeps the original snapshot when an already-offboarded person is offboarded again", async () => {
    const person = await seedActiveMember();

    // 1. The real offboard. Captures SU26 and flips the membership to REMOVED.
    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");
    // 2. Reactivation is status-only and deliberately does NOT restore the
    //    membership, so the person is now ACTIVE with nothing to compute from.
    await setPersonStatusField(ACTOR, person.id, "ACTIVE");
    // 3. A second offboard. Re-snapshotting here would upsert an EMPTY record
    //    over the good one, and nothing can recompute SU26 -- step 1 already
    //    set it to REMOVED.
    await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");

    const credential = await getCredential(person.id);
    expect(credential!.record.terms).toHaveLength(1);
    expect(credential!.record.terms[0].termCode).toBe("SU26");
  });

  it("does not issue a credential when the status change is not an offboard", async () => {
    const person = await seedActiveMember();

    await setPersonStatusField(ACTOR, person.id, "ACTIVE");

    expect(await getCredential(person.id)).toBeNull();
  });

  it("still completes the offboard when the snapshot fails at the database level", async () => {
    const person = await seedActiveMember();

    // A bare `mockRejectedValueOnce` would NOT reproduce the bug this test
    // regresses: the old code awaited issueServiceCredential(personId, tx)
    // INSIDE the offboard transaction, and a plain JS-level throw there was
    // already caught fine by its try/catch. The actual hazard (see the
    // comment in people.ts, and audit.ts's catch block) is a DB-level
    // failure on the connection issueServiceCredential is handed: Postgres
    // marks THAT connection's transaction aborted at the wire level, so the
    // *next* statement on the same connection fails uncaught even though the
    // failure itself was caught. Reproduce that exactly by running a real
    // failing statement against whatever client the caller passes in.
    // Called with the (fixed) singleton client, this only fails a one-off,
    // unrelated statement. Called with a tx client (the bug), it poisons the
    // whole offboard transaction and the very next statement
    // (termMembership.updateMany) blows up uncaught, rolling everything back
    // -- which is exactly what this test would catch if the fix regressed.
    vi.mocked(issueServiceCredential).mockImplementationOnce(async (_personId, client = prisma) => {
      await client.$executeRawUnsafe("SELECT 1/0");
      throw new Error("unreachable: the statement above always throws");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let updated: Awaited<ReturnType<typeof setPersonStatusField>>;
    try {
      updated = await setPersonStatusField(ACTOR, person.id, "OFFBOARDED");
    } finally {
      consoleErrorSpy.mockRestore();
    }

    // The offboard is unaffected by the snapshot failure: status flipped and
    // the membership was still removed, because the failing statement above
    // never touched the offboard transaction's own connection.
    expect(updated.status).toBe("OFFBOARDED");
    const memberships = await prisma.termMembership.findMany({ where: { personId: person.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe("REMOVED");

    // And no credential was left behind by the failed attempt.
    expect(await getCredential(person.id)).toBeNull();
  });
});
