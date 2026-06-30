import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createDraft, updateCampaign, scheduleCampaign } from "./service";
import { dispatchDueCampaigns } from "./dispatch";

beforeEach(resetDb);

const ALL_ACTIVE = { recordType: "PERSON" as const, match: "ALL" as const, conditions: [{ field: "status", op: "eq" as const, value: "ACTIVE" }] };

async function readyCampaign(name: string) {
  const c = await createDraft(null, name);
  await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>Hi {{ firstName }}</p>", audience: ALL_ACTIVE });
  return c;
}

describe("dispatchDueCampaigns", () => {
  it("runs a due one-time campaign once and marks it SENT", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    const c = await readyCampaign("OneTime");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") });

    let summary = await dispatchDueCampaigns(new Date("2026-06-10T11:59:00Z"));
    expect(summary.executed).toBe(0);

    summary = await dispatchDueCampaigns(new Date("2026-06-10T12:00:30Z"));
    expect(summary.executed).toBe(1);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
    expect(after.lastRunAt).not.toBeNull();
    const logs = await prisma.emailLog.findMany({ where: { template: "campaign" } });
    expect(logs.length).toBe(1);

    summary = await dispatchDueCampaigns(new Date("2026-06-10T13:00:00Z"));
    expect(summary.executed).toBe(0);
  });

  it("runs a recurring campaign and advances nextRunAt, staying ACTIVE", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    const c = await readyCampaign("Daily");
    await scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "0 13 * * *" }, new Date("2026-06-10T12:00:00Z"));

    const summary = await dispatchDueCampaigns(new Date("2026-06-10T13:00:30Z"));
    expect(summary.executed).toBe(1);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.nextRunAt?.toISOString()).toBe("2026-06-11T13:00:00.000Z");
    const runs = await prisma.emailCampaignRun.findMany({ where: { campaignId: c.id } });
    expect(runs.length).toBe(1);
  });

  it("does not double-dispatch a one-time campaign when two passes overlap", async () => {
    // Two overlapping ticks (a slow tick can run up to maxDuration=300s and lap
    // the next minute's tick) must enqueue the audience exactly once. Two
    // recipients keep each dispatch transaction open long enough to overlap and
    // make a double-send unmistakable (2 logs, not 4).
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    await prisma.person.create({ data: { name: "Pat Lee", contactEmail: "pat@example.com", status: "ACTIVE" } });
    const c = await readyCampaign("Overlap");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") });

    const now = new Date("2026-06-10T12:00:30Z");
    const summaries = await Promise.all([dispatchDueCampaigns(now), dispatchDueCampaigns(now)]);
    // Exactly one pass claims and runs; the other is a benign dedup, not an
    // error -- it must not inflate the cron tick's error count.
    expect(summaries.reduce((n, s) => n + s.executed, 0)).toBe(1);
    expect(summaries.reduce((n, s) => n + s.errors, 0)).toBe(0);

    const runs = await prisma.emailCampaignRun.findMany({ where: { campaignId: c.id } });
    expect(runs.length).toBe(1);
    const logs = await prisma.emailLog.findMany({ where: { template: "campaign" } });
    expect(logs.length).toBe(2);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
  });

  it("does not double-dispatch a recurring campaign when two passes overlap", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    await prisma.person.create({ data: { name: "Pat Lee", contactEmail: "pat@example.com", status: "ACTIVE" } });
    const c = await readyCampaign("OverlapDaily");
    await scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "0 13 * * *" }, new Date("2026-06-10T12:00:00Z"));

    const now = new Date("2026-06-10T13:00:30Z");
    const summaries = await Promise.all([dispatchDueCampaigns(now), dispatchDueCampaigns(now)]);
    expect(summaries.reduce((n, s) => n + s.executed, 0)).toBe(1);
    expect(summaries.reduce((n, s) => n + s.errors, 0)).toBe(0);

    const runs = await prisma.emailCampaignRun.findMany({ where: { campaignId: c.id } });
    expect(runs.length).toBe(1);
    const logs = await prisma.emailLog.findMany({ where: { template: "campaign" } });
    expect(logs.length).toBe(2);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.nextRunAt?.toISOString()).toBe("2026-06-11T13:00:00.000Z");
  });

  it("skips CANCELLED campaigns", async () => {
    const c = await readyCampaign("Stopped");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "CANCELLED" } });
    const summary = await dispatchDueCampaigns(new Date("2026-06-10T12:01:00Z"));
    expect(summary.executed).toBe(0);
  });
});
