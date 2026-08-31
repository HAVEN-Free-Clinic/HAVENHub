import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

const REMINDER_TEMPLATE = "schedule-request-submitted-director";
const DIGEST_TEMPLATE = "schedule-request-digest-exec";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("CRON_SECRET", "sekret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 3 * DAY_MS); // older than the 48h cutoff
/** Past the ED digest's 4-day escalation bar, which OLD deliberately is not. */
const STALE = new Date(Date.now() - 5 * DAY_MS);
/** A clinic date inside the urgent window, so the request escalates on sight. */
const THIS_CLINIC_WEEK = new Date(Date.now() + 3 * DAY_MS);

async function director(name: string) {
  const p = await prisma.person.create({ data: { name, contactEmail: `${name.toLowerCase()}@yale.edu`, status: "ACTIVE" } });
  return p;
}

async function pendingRequest(
  termId: string,
  deptId: string,
  requesterId: string,
  over: { createdAt?: Date; requesterDate?: Date } = {},
) {
  return prisma.shiftRequest.create({
    data: {
      termId, departmentId: deptId, requesterId,
      requesterDate: over.requesterDate ?? new Date("2026-06-06T12:00:00Z"),
      status: "PENDING", createdAt: over.createdAt ?? OLD,
    },
  });
}

describe("GET /api/cron/schedule-reminders", () => {
  it("401s without the bearer secret", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/schedule-reminders"));
    expect(res.status).toBe(401);
  });

  // A request whose term has been archived can no longer be decided anywhere in
  // the app, so reminding its approvers is a dead-end nag. The live term is still
  // reminded; the archived one is not.
  it("reminds approvers of live-term requests but not archived-term requests", async () => {
    const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30T12:00:00Z"), endDate: new Date("2026-09-26T12:00:00Z"), status: "ACTIVE" } });
    const archived = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date("2026-01-05T12:00:00Z"), endDate: new Date("2026-05-01T12:00:00Z"), status: "ARCHIVED" } });
    const deptA = await prisma.department.create({ data: { code: "AAAA", name: "Dept A" } });
    const deptB = await prisma.department.create({ data: { code: "BBBB", name: "Dept B" } });
    const dirA = await director("Ann");
    const dirB = await director("Bob");
    const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });

    // Each director manages their department via a live-term directorship
    // (departmentDirectorPersonIds is live-term-derived, so dirB is still a valid
    // approver for the archived-term request; only the term filter stops the nag).
    await prisma.termMembership.create({ data: { personId: dirA.id, termId: live.id, departmentId: deptA.id, kind: "DIRECTOR", status: "ACTIVE" } });
    await prisma.termMembership.create({ data: { personId: dirB.id, termId: live.id, departmentId: deptB.id, kind: "DIRECTOR", status: "ACTIVE" } });

    await pendingRequest(live.id, deptA.id, vol.id);
    await pendingRequest(archived.id, deptB.id, vol.id);

    const { GET } = await import("./route");
    const res = await GET(new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } }));
    expect(res.status).toBe(200);

    const reminded = await prisma.emailLog.findMany({ where: { template: REMINDER_TEMPLATE }, select: { personId: true } });
    const remindedIds = reminded.map((e) => e.personId);
    expect(remindedIds).toContain(dirA.id);
    expect(remindedIds).not.toContain(dirB.id);
  });

  // audit 14. The template ends with an unconditional
  // <a href="{{ requestsUrl }}">Review pending requests</a>, and only ONE of the
  // three sites that render it supplied that variable. The renderer resolves a
  // missing key to "", so this cron -- the one that runs every day, to every
  // approver -- shipped a dead button.
  it("renders the approvals CTA with a real href, not an empty one", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SU26", name: "Summer",
        startDate: new Date("2026-05-30T12:00:00Z"), endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
      },
    });
    const dept = await prisma.department.create({ data: { code: "CTAX", name: "Dept CTA" } });
    const dir = await director("Cta");
    const vol = await prisma.person.create({ data: { name: "VolCta", status: "ACTIVE" } });
    await prisma.termMembership.create({
      data: { personId: dir.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
    });
    await pendingRequest(term.id, dept.id, vol.id);

    const { GET } = await import("./route");
    await GET(new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } }));

    const mail = await prisma.emailLog.findFirstOrThrow({
      where: { template: REMINDER_TEMPLATE, personId: dir.id },
    });
    expect(mail.html).not.toContain('href=""');
    expect(mail.html).toMatch(/href="https?:\/\/[^"]*\/schedule\/requests"/);
  });
});

// ---------------------------------------------------------------------------
// Executive Director digest
//
// The EDs are not approvers, so they are not in requestApproverRecipients and
// never saw these reminders. Copying them onto the per-department email would
// not have worked either: the per-person daily claim admits ONE reminder per
// person per day, so an ED watching every department would have learned about
// exactly one stalled request a day. They get one digest instead.
//
// The digest has its own bar (belongsInDigest), NOT the approver cadence: the
// coming clinic week at any age, or four days untouched. Neither list contains
// the other, which is why these cases pin both directions.
// ---------------------------------------------------------------------------

describe("GET /api/cron/schedule-reminders: Executive Director digest", () => {
  async function scenario() {
    const term = await prisma.term.create({
      data: {
        code: "SU26", name: "Summer",
        startDate: new Date("2026-05-30T12:00:00Z"), endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
      },
    });
    const exec = await prisma.department.create({ data: { code: "EXEC", name: "Executive Directors" } });
    const ed = await director("Eddie");
    await prisma.termMembership.create({
      data: { personId: ed.id, termId: term.id, departmentId: exec.id, kind: "DIRECTOR", status: "ACTIVE" },
    });
    return { term, exec, ed };
  }

  it("sends the EDs one digest naming every department with a pending request", async () => {
    const { term, ed } = await scenario();
    const deptA = await prisma.department.create({ data: { code: "AAAA", name: "Dept A" } });
    const deptB = await prisma.department.create({ data: { code: "BBBB", name: "Dept B" } });
    const dirA = await director("Ann");
    await prisma.termMembership.create({
      data: { personId: dirA.id, termId: term.id, departmentId: deptA.id, kind: "DIRECTOR", status: "ACTIVE" },
    });
    const vol = await prisma.person.create({ data: { name: "Vic Volunteer", status: "ACTIVE" } });
    await pendingRequest(term.id, deptA.id, vol.id, { createdAt: STALE });
    await pendingRequest(term.id, deptB.id, vol.id, { createdAt: STALE });

    const { GET } = await import("./route");
    await GET(new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } }));

    const digests = await prisma.emailLog.findMany({ where: { template: DIGEST_TEMPLATE } });
    expect(digests).toHaveLength(1);
    expect(digests[0].personId).toBe(ed.id);
    expect(digests[0].subject).toBe("2 shift requests still pending review");
    // Dept B has no director at all, so nobody was reminded about it above. It
    // still belongs in the digest: an unowned request is the one most likely to
    // rot, which is the whole reason the EDs are being told.
    expect(digests[0].html).toContain("Dept A");
    expect(digests[0].html).toContain("Dept B");
    expect(digests[0].html).toContain("Vic Volunteer");
    // The list is injected with {{{ }}}. A double-brace slip would ship the
    // markup as visible text rather than as the grouped blocks.
    expect(digests[0].html).not.toContain("&lt;strong&gt;");
    expect(digests[0].html).toMatch(/<p><strong>Dept A<\/strong><br\/>Drop: Vic Volunteer/);
  });

  // An ED who is also a department director is a real configuration. The two
  // emails answer different questions ("decide this" vs "this is stalled"), so
  // both must survive; they take separate per-day claims to make that possible.
  it("still sends the per-department reminder to an ED who is also that department's director", async () => {
    const { term, exec, ed } = await scenario();
    const vol = await prisma.person.create({ data: { name: "Vic Volunteer", status: "ACTIVE" } });
    await pendingRequest(term.id, exec.id, vol.id, { createdAt: STALE });

    const { GET } = await import("./route");
    await GET(new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } }));

    const templates = (
      await prisma.emailLog.findMany({ where: { personId: ed.id }, select: { template: true } })
    ).map((e) => e.template);
    expect(templates).toContain(REMINDER_TEMPLATE);
    expect(templates).toContain(DIGEST_TEMPLATE);
  });

  // The clinic-week lane has no age floor at all: the shift is days away and
  // there is no later approval slot, so waiting to escalate costs the coverage.
  // This request is also younger than the 12h floor the query itself used to
  // carry, so it pins that the query no longer prefilters on age.
  it("escalates a coming-week request filed minutes ago, before any approver reminder is due", async () => {
    const { term, ed } = await scenario();
    const dept = await prisma.department.create({ data: { code: "CCCC", name: "Dept C" } });
    const vol = await prisma.person.create({ data: { name: "Vic Volunteer", status: "ACTIVE" } });
    await pendingRequest(term.id, dept.id, vol.id, {
      createdAt: new Date(Date.now() - 60 * 1000),
      requesterDate: THIS_CLINIC_WEEK,
    });

    const { GET } = await import("./route");
    await GET(new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } }));

    const digest = await prisma.emailLog.findFirstOrThrow({
      where: { template: DIGEST_TEMPLATE, personId: ed.id },
    });
    expect(digest.html).toContain("clinic within");
    // The department's own reminder is NOT due yet (12h floor), so this is the
    // digest reaching the EDs first, not a copy of something already sent.
    expect(await prisma.emailLog.count({ where: { template: REMINDER_TEMPLATE } })).toBe(0);
  });

  // Three days is past the department's own 48-hour first reminder but short of
  // the four-day escalation bar. The department is being chased; the EDs are not
  // told yet.
  it("does not escalate a request that is being reminded on but is under four days old", async () => {
    const { term } = await scenario();
    const dept = await prisma.department.create({ data: { code: "CCCC", name: "Dept C" } });
    const dir = await director("Dora");
    await prisma.termMembership.create({
      data: { personId: dir.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
    });
    const vol = await prisma.person.create({ data: { name: "Vic Volunteer", status: "ACTIVE" } });
    await pendingRequest(term.id, dept.id, vol.id, { createdAt: OLD });

    const { GET } = await import("./route");
    await GET(new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } }));

    // The approver reminder went out; only the escalation held back.
    expect(await prisma.emailLog.count({ where: { template: REMINDER_TEMPLATE, personId: dir.id } })).toBe(1);
    expect(await prisma.emailLog.count({ where: { template: DIGEST_TEMPLATE } })).toBe(0);
  });

  // A digest that arrives every morning saying "nothing pending" trains the
  // reader to ignore the subject line, including on the morning it is not empty.
  it("sends no digest when nothing has reached the bar", async () => {
    const { term } = await scenario();
    const dept = await prisma.department.create({ data: { code: "CCCC", name: "Dept C" } });
    const vol = await prisma.person.create({ data: { name: "Vic Volunteer", status: "ACTIVE" } });
    // Filed a minute ago, for a clinic date long past: neither lane applies.
    await pendingRequest(term.id, dept.id, vol.id, { createdAt: new Date(Date.now() - 60 * 1000) });

    const { GET } = await import("./route");
    await GET(new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } }));

    expect(await prisma.emailLog.count({ where: { template: DIGEST_TEMPLATE } })).toBe(0);
  });

  // The per-day claim is what stops a re-fired or overlapping cron from mailing
  // the executive team twice in a morning.
  it("sends one digest per ED per day however often the cron runs", async () => {
    const { term } = await scenario();
    const dept = await prisma.department.create({ data: { code: "DDDD", name: "Dept D" } });
    const vol = await prisma.person.create({ data: { name: "Vic Volunteer", status: "ACTIVE" } });
    await pendingRequest(term.id, dept.id, vol.id, { createdAt: STALE });

    const { GET } = await import("./route");
    const req = () => new Request("https://x/api/cron/schedule-reminders", { headers: { Authorization: "Bearer sekret" } });
    await GET(req());
    await GET(req());

    expect(await prisma.emailLog.count({ where: { template: DIGEST_TEMPLATE } })).toBe(1);
  });
});
