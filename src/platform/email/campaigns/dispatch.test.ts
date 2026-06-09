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

  it("skips CANCELLED campaigns", async () => {
    const c = await readyCampaign("Stopped");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "CANCELLED" } });
    const summary = await dispatchDueCampaigns(new Date("2026-06-10T12:01:00Z"));
    expect(summary.executed).toBe(0);
  });
});
