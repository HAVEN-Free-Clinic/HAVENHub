import { beforeEach, describe, expect, it, vi } from "vitest";
import * as rbac from "@/platform/rbac/engine";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createDraft,
  updateCampaign,
  scheduleCampaign,
  sendCampaignNow,
  testSend,
  editManualLists,
  unscheduleCampaign,
  duplicateCampaign,
  deleteDraftCampaign,
  heartbeatPresence,
  leavePresence,
  campaignDelivery,
  retryFailedDeliveries,
  campaignActivity,
  listCampaigns,
  CampaignConflictError,
  CampaignValidationError,
  PRESENCE_WINDOW_MS,
} from "./service";

beforeEach(resetDb);

const ALL_ACTIVE = {
  recordType: "PERSON" as const,
  match: "ALL" as const,
  conditions: [{ field: "status", op: "eq" as const, value: "ACTIVE" }],
};

const BEFORE_SEND = new Date("2026-06-10T11:00:00Z");
const SEND_AT = new Date("2026-06-10T12:00:00Z");

async function person(name: string, email: string) {
  return prisma.person.create({ data: { name, contactEmail: email, status: "ACTIVE" } });
}

async function ready(actorId: string | null = null) {
  const c = await createDraft(actorId, "Newsletter");
  await updateCampaign(actorId, c.id, { subject: "Hi {{ firstName }}", body: "<p>Hello</p>", audience: ALL_ACTIVE });
  return prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
}

describe("co-editing", () => {
  it("bumps contentVersion and records who saved", async () => {
    const alex = await person("Alex Kim", "alex@example.com");
    const c = await createDraft(alex.id, "Newsletter");
    expect(c.contentVersion).toBe(0);
    const saved = await updateCampaign(alex.id, c.id, {
      subject: "s",
      body: "b",
      audience: ALL_ACTIVE,
      expectedVersion: 0,
    });
    expect(saved.contentVersion).toBe(1);
    expect(saved.updatedById).toBe(alex.id);
  });

  it("refuses a save loaded at an older version and names who saved first", async () => {
    const alex = await person("Alex Kim", "alex@example.com");
    const blair = await person("Blair Ng", "blair@example.com");
    const c = await createDraft(alex.id, "Newsletter");

    // Both opened the editor at version 0. Alex saves first.
    await updateCampaign(alex.id, c.id, { subject: "Alex", body: "a", audience: ALL_ACTIVE, expectedVersion: 0 });

    const err = await updateCampaign(blair.id, c.id, {
      subject: "Blair",
      body: "b",
      audience: ALL_ACTIVE,
      expectedVersion: 0,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CampaignConflictError);
    expect((err as CampaignConflictError).savedByName).toBe("Alex Kim");

    const row = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.subject).toBe("Alex");
  });

  it("overwrites when no version is given (explicit Save anyway)", async () => {
    const c = await createDraft(null, "Newsletter");
    await updateCampaign(null, c.id, { subject: "first", body: "a", audience: ALL_ACTIVE, expectedVersion: 0 });
    await updateCampaign(null, c.id, { subject: "forced", body: "b", audience: ALL_ACTIVE });
    const row = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.subject).toBe("forced");
    expect(row.contentVersion).toBe(2);
  });

  it("does not treat a manual-list edit as a conflicting save", async () => {
    const sam = await person("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Newsletter");
    await editManualLists(null, c.id, { op: "include", personId: sam.id });
    await expect(
      updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE, expectedVersion: 0 }),
    ).resolves.toBeTruthy();
  });

  it("still refuses a stale save on a campaign that has since been sent", async () => {
    await person("Sam Rivera", "sam@example.com");
    const c = await ready();
    await sendCampaignNow(null, c.id, {});
    await expect(
      updateCampaign(null, c.id, { subject: "x", body: "y", audience: ALL_ACTIVE, expectedVersion: c.contentVersion }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("reports other editors inside the window, never the caller", async () => {
    const alex = await person("Alex Kim", "alex@example.com");
    const blair = await person("Blair Ng", "blair@example.com");
    const casey = await person("Casey Lo", "casey@example.com");
    const c = await createDraft(alex.id, "Newsletter");
    const now = new Date("2026-06-10T12:00:00Z");

    await heartbeatPresence(c.id, blair.id, now);
    // Casey's last beat is outside the window, so they have left.
    await heartbeatPresence(c.id, casey.id, new Date(now.getTime() - PRESENCE_WINDOW_MS - 1000));

    const seen = await heartbeatPresence(c.id, alex.id, now);
    expect(seen.editors).toEqual(["Blair Ng"]);
    expect(seen.contentVersion).toBe(0);

    await leavePresence(c.id, blair.id);
    expect((await heartbeatPresence(c.id, alex.id, now)).editors).toEqual([]);
  });

  it("does not log an audience change when only key order differs (jsonb reorders keys)", async () => {
    const c = await createDraft(null, "Newsletter");
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
    const reordered = {
      conditions: [{ value: "ACTIVE", op: "eq" as const, field: "status" }],
      match: "ALL" as const,
      recordType: "PERSON" as const,
    };
    await updateCampaign(null, c.id, { subject: "s2", body: "b", audience: reordered });
    const [latest] = await campaignActivity(c.id);
    expect(latest.after).toEqual({ fields: ["subject"] });
  });

  it("records changed fields in the activity log", async () => {
    const alex = await person("Alex Kim", "alex@example.com");
    const c = await createDraft(alex.id, "Newsletter");
    await updateCampaign(alex.id, c.id, { name: "Newsletter", subject: "New subject", body: "", audience: c.audienceJson as never });
    const activity = await campaignActivity(c.id);
    expect(activity[0]).toMatchObject({ action: "campaign.update", actorName: "Alex Kim" });
    expect(activity[0].after).toEqual({ fields: ["subject"] });
  });
});

describe("lifecycle", () => {
  it("moves a scheduled campaign back to an editable draft", async () => {
    await person("Sam Rivera", "sam@example.com");
    const c = await ready();
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: SEND_AT }, BEFORE_SEND);
    await unscheduleCampaign(null, c.id);
    const row = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(row).toMatchObject({ status: "DRAFT", nextRunAt: null, scheduledAt: null });
    await expect(
      updateCampaign(null, c.id, { subject: "Fixed typo", body: "<p>Hello</p>", audience: ALL_ACTIVE }),
    ).resolves.toBeTruthy();
  });

  it("refuses to unschedule a campaign that already went out", async () => {
    await person("Sam Rivera", "sam@example.com");
    const c = await ready();
    await sendCampaignNow(null, c.id, {});
    await expect(unscheduleCampaign(null, c.id)).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("duplicates content and lists into a new draft with no runs", async () => {
    const sam = await person("Sam Rivera", "sam@example.com");
    const alex = await person("Alex Kim", "alex@example.com");
    const c = await ready();
    await editManualLists(null, c.id, { op: "exclude", personId: sam.id });
    await sendCampaignNow(null, c.id, {});

    const { id } = await duplicateCampaign(alex.id, c.id);
    const copy = await prisma.emailCampaign.findUniqueOrThrow({ where: { id }, include: { runs: true } });
    expect(copy).toMatchObject({
      name: "Copy of Newsletter",
      status: "DRAFT",
      subject: "Hi {{ firstName }}",
      excludePersonIds: [sam.id],
      createdById: alex.id,
      scopeId: null,
    });
    expect(copy.runs).toHaveLength(0);
  });

  it("deletes only a draft that never sent", async () => {
    await person("Sam Rivera", "sam@example.com");
    const draft = await createDraft(null, "Scratch");
    await deleteDraftCampaign(null, draft.id);
    expect(await prisma.emailCampaign.findUnique({ where: { id: draft.id } })).toBeNull();

    const sent = await ready();
    await sendCampaignNow(null, sent.id, {});
    await expect(deleteDraftCampaign(null, sent.id)).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("refuses a test send with no subject or body, naming what is missing", async () => {
    const c = await createDraft(null, "Empty");
    const err = await testSend(null, c.id, "me@example.com").catch((e) => e);
    expect(err).toBeInstanceOf(CampaignValidationError);
    expect((err as CampaignValidationError).problems).toEqual([
      "Add a subject before sending a test.",
      "Add a message body before sending a test.",
    ]);
  });
});

describe("delivery", () => {
  it("counts queued, sent and failed per run and retries only this campaign's failures", async () => {
    await person("Sam Rivera", "sam@example.com");
    await person("Ana Diaz", "ana@example.com");
    const c = await ready();
    const { runId } = await sendCampaignNow(null, c.id, {});

    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: runId }, orderBy: { toEmail: "asc" } });
    await prisma.emailLog.update({ where: { id: logs[0].id }, data: { status: "FAILED", lastError: "550 mailbox unavailable" } });
    await prisma.emailLog.update({ where: { id: logs[1].id }, data: { status: "SENT", sentAt: new Date() } });
    // Someone else's failed email, which retry must not touch.
    const other = await prisma.emailLog.create({
      data: { toEmail: "x@example.com", subject: "s", html: "h", template: "other", status: "FAILED" },
    });

    const delivery = await campaignDelivery(c.id);
    expect(delivery.runs).toEqual([{ runId, queued: 0, sent: 1, failed: 1 }]);
    expect(delivery.failed).toEqual([
      { id: logs[0].id, runId, toEmail: "ana@example.com", lastError: "550 mailbox unavailable" },
    ]);
    expect(delivery.failedTotal).toBe(1);

    expect(await retryFailedDeliveries(null, c.id)).toBe(1);
    const retried = await prisma.emailLog.findUniqueOrThrow({ where: { id: logs[0].id } });
    expect(retried).toMatchObject({ status: "QUEUED", attempts: 0, lastError: null });
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("FAILED");
  });

  it("lists campaigns with run totals and last editor", async () => {
    const alex = await person("Alex Kim", "alex@example.com");
    const c = await ready(alex.id);
    await sendCampaignNow(alex.id, c.id, {});
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
    const [row] = await listCampaigns(alex.id);
    expect(row.runs[0].recipientCount).toBe(1);
    expect(row.updatedBy?.name).toBe("Alex Kim");
    vi.restoreAllMocks();
  });
});
