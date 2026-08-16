import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

const REMINDER_TEMPLATE = "schedule-request-submitted-director";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("CRON_SECRET", "sekret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const OLD = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // older than the 48h cutoff

async function director(name: string) {
  const p = await prisma.person.create({ data: { name, contactEmail: `${name.toLowerCase()}@yale.edu`, status: "ACTIVE" } });
  return p;
}

async function pendingRequest(termId: string, deptId: string, requesterId: string) {
  return prisma.shiftRequest.create({
    data: {
      termId, departmentId: deptId, requesterId,
      requesterDate: new Date("2026-06-06T12:00:00Z"),
      status: "PENDING", createdAt: OLD,
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
