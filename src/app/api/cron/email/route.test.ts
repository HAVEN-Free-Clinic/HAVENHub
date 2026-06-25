import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createDraft, updateCampaign, scheduleCampaign } from "@/platform/email/campaigns/service";
import { queueEmail } from "@/platform/email/send";
import { GET } from "./route";

// Set CRON_SECRET early so the module-level check in the Teams describe block works.
process.env.CRON_SECRET = process.env.CRON_SECRET ?? "test-cron-secret";

const CRON_SECRET = "test-cron-secret";
const ALL_ACTIVE = {
  recordType: "PERSON" as const,
  match: "ALL" as const,
  conditions: [{ field: "status", op: "eq" as const, value: "ACTIVE" }],
};

function cronRequest(auth?: string): Request {
  return new Request("http://localhost/api/cron/email", {
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(async () => {
  await resetDb();
  process.env.CRON_SECRET = CRON_SECRET;
});

describe("GET /api/cron/email", () => {
  it("rejects an unauthorized request and sends nothing", async () => {
    await queueEmail(prisma, {
      to: "queued@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      template: "test",
    });

    const res = await GET(cronRequest("Bearer wrong"));
    expect(res.status).toBe(401);

    const row = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "queued@example.com" } });
    expect(row.status).toBe("QUEUED");
  });

  it("delivers an already-queued immediate email on this pass", async () => {
    await queueEmail(prisma, {
      to: "now@example.com",
      subject: "Send me now",
      html: "<p>now</p>",
      template: "test",
    });

    const res = await GET(cronRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.emails).toBe(1);

    const row = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "now@example.com" } });
    expect(row.status).toBe("SENT");
    expect(row.sentAt).not.toBeNull();
  });

  it("dispatches a due scheduled campaign and delivers its emails on the same pass", async () => {
    await prisma.person.create({
      data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" },
    });
    const c = await createDraft(null, "Due Campaign");
    await updateCampaign(null, c.id, {
      subject: "Hi {{ firstName }}",
      body: "<p>Hi {{ firstName }}</p>",
      audience: ALL_ACTIVE,
    });
    await scheduleCampaign(null, c.id, {
      scheduleType: "SCHEDULED",
      scheduledAt: new Date(Date.now() - 60_000),
    });

    const res = await GET(cronRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatched).toBe(1);

    const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(campaign.status).toBe("SENT");

    const sent = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "sam@example.com" } });
    expect(sent.status).toBe("SENT");
  });
});

describe("GET /api/cron/email drains Teams", () => {
  beforeEach(async () => await resetDb());

  it("includes a teams count and marks queued Teams messages LOGGED (log transport)", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    await prisma.teamsMessage.create({
      data: {
        personId: p.id,
        type: "epic-onboarding",
        title: "T",
        summary: "S",
        bodyHtml: "<p>x</p>",
        fallbackSubject: "T",
        fallbackHtml: "<p>x</p>",
      },
    });

    const req = new Request("https://app/api/cron/email", {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    const res = await GET(req);
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.teams).toBeGreaterThanOrEqual(1);
    const row = await prisma.teamsMessage.findFirst({ where: { personId: p.id } });
    // email.transport defaults to "log", so the log transport records the row as
    // LOGGED (recorded but not actually sent), never SENT.
    expect(row?.status).toBe("LOGGED");
  });
});
