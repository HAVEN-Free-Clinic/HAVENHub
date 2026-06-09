import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createDraft, updateCampaign, previewAudience, sendCampaignNow,
  scheduleCampaign, cancelCampaign,
  CampaignValidationError, CampaignConfirmationError,
} from "./service";
import * as audienceResolve from "@/platform/email/audience/resolve";

beforeEach(resetDb);

async function activePerson(name: string, email: string) {
  return prisma.person.create({ data: { name, contactEmail: email, status: "ACTIVE" } });
}

const ALL_ACTIVE = { recordType: "PERSON" as const, match: "ALL" as const, conditions: [{ field: "status", op: "eq" as const, value: "ACTIVE" }] };

describe("campaign service", () => {
  it("creates a draft, updates it, previews recipients", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Newsletter");
    await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>{{ name }}</p>", audience: ALL_ACTIVE });
    const preview = await previewAudience(c.id);
    expect(preview.count).toBe(1);
    expect(preview.sample[0].email).toBe("sam@example.com");
  });

  it("rejects a body with unknown variables", async () => {
    const c = await createDraft(null, "Bad");
    await expect(
      updateCampaign(null, c.id, { subject: "x", body: "{{ bogus }}", audience: ALL_ACTIVE }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("send-now enqueues one email per recipient and marks SENT", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    const c = await createDraft(null, "Blast");
    await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>Hi {{ firstName }}</p>", audience: ALL_ACTIVE });
    const res = await sendCampaignNow(null, c.id, {});
    expect(res.recipientCount).toBe(2);
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect(logs.length).toBe(2);
    expect(logs.every((l) => l.html.includes("HAVEN Free Clinic"))).toBe(true);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
  });

  it("requires a matching typed count above the threshold", async () => {
    for (let i = 0; i < 26; i++) await activePerson(`P ${i}`, `p${i}@example.com`);
    const c = await createDraft(null, "Big");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(sendCampaignNow(null, c.id, {})).rejects.toBeInstanceOf(CampaignConfirmationError);
    const ok = await sendCampaignNow(null, c.id, { confirmCount: 26 });
    expect(ok.recipientCount).toBe(26);
  });

  it("rejects sending a campaign that is not a draft", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Once");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await sendCampaignNow(null, c.id, {});
    await expect(sendCampaignNow(null, c.id, {})).rejects.toThrow(/already sent/i);
  });

  it("rejects editing a campaign that has already been sent", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Locked");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await sendCampaignNow(null, c.id, {});
    await expect(
      updateCampaign(null, c.id, { subject: "s2", body: "<p>x</p>", audience: ALL_ACTIVE }),
    ).rejects.toThrow(/cannot edit/i);
  });

  it("de-duplicates recipients by email (case-insensitive)", async () => {
    // The DB enforces lower(contactEmail) uniqueness, so two Person rows with
    // emails differing only in case cannot coexist. To exercise the service's
    // dedup logic we mock resolveAudience to return two entries whose emails
    // collapse to the same lowercase key, verifying the Set-based filter fires.
    const person = await activePerson("Sam Rivera", "dup@example.com");
    const c = await createDraft(null, "Dedup");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi {{ firstName }}</p>", audience: ALL_ACTIVE });

    const spy = vi.spyOn(audienceResolve, "resolveAudience").mockResolvedValueOnce({
      recipients: [
        { email: "dup@example.com", displayName: "Sam Rivera", recordType: "PERSON", recordId: person.id, variables: { firstName: "Sam", name: "Sam Rivera" } },
        { email: "DUP@example.com", displayName: "Sam Clone", recordType: "PERSON", recordId: person.id, variables: { firstName: "Sam", name: "Sam Clone" } },
      ],
      excludedNoEmail: 0,
    });

    try {
      const res = await sendCampaignNow(null, c.id, {});
      expect(res.recipientCount).toBe(1);
      const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
      expect(logs.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("campaign scheduling", () => {
  it("schedules a one-time send and sets SCHEDULED + nextRunAt = scheduledAt", async () => {
    const c = await createDraft(null, "Later");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    const at = new Date("2030-01-01T12:00:00Z");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: at });
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SCHEDULED");
    expect(after.scheduledAt?.toISOString()).toBe(at.toISOString());
    expect(after.nextRunAt?.toISOString()).toBe(at.toISOString());
  });

  it("schedules a recurring send and sets ACTIVE + nextRunAt from cron", async () => {
    const c = await createDraft(null, "Weekly");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    const now = new Date("2026-06-10T12:00:00Z");
    await scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "0 13 * * *" }, now);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.cronExpr).toBe("0 13 * * *");
    expect(after.nextRunAt?.toISOString()).toBe("2026-06-10T13:00:00.000Z");
  });

  it("rejects an invalid cron and a scheduled time/cron mismatch", async () => {
    const c = await createDraft(null, "Bad");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "nope" }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED" }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("cancel sets CANCELLED", async () => {
    const c = await createDraft(null, "Stop");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2030-01-01T00:00:00Z") });
    await cancelCampaign(null, c.id);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("CANCELLED");
  });
});
