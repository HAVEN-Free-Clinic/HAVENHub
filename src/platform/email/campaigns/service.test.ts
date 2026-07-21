import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createDraft, updateCampaign, previewAudience, sendCampaignNow,
  scheduleCampaign, cancelCampaign, executeRun,
  CampaignValidationError, CampaignConfirmationError,
} from "./service";
import * as audienceResolve from "@/platform/email/audience/resolve";
import * as sendModule from "@/platform/email/send";

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

  it("seeds subject/body/name from a starter and stays empty without one", async () => {
    const blank = await createDraft(null, "");
    expect(blank.subject).toBe("");
    expect(blank.body).toBe("");
    expect(blank.name).toBe("Untitled campaign");

    const seeded = await createDraft(null, "", { starterId: "welcome" });
    expect(seeded.name).toBe("Welcome to HAVEN Hub");
    expect(seeded.subject).toContain("Welcome to HAVEN Hub");
    expect(seeded.body).toContain("docs.havenfreeclinic.org");

    // An explicit name wins over the starter's default name.
    const named = await createDraft(null, "Fall blast", { starterId: "welcome" });
    expect(named.name).toBe("Fall blast");

    // An unknown starter id falls back to an empty draft rather than throwing.
    const unknown = await createDraft(null, "Mystery", { starterId: "nope" });
    expect(unknown.body).toBe("");

    // The seeded body passes the same validation updateCampaign enforces on save.
    const saved = await updateCampaign(null, seeded.id, {
      subject: seeded.subject,
      body: seeded.body,
      audience: ALL_ACTIVE,
    });
    expect(saved.status).toBe("DRAFT");
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

  it("refuses to send a campaign with a blank subject", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    const c = await createDraft(null, "NoSubject");
    await updateCampaign(null, c.id, { subject: "   ", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(sendCampaignNow(null, c.id, {})).rejects.toBeInstanceOf(CampaignValidationError);
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

  it("executeRun refuses to re-run a SENT campaign (double-dispatch guard)", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    const c = await createDraft(null, "Once2");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await sendCampaignNow(null, c.id, {}); // now SENT
    await expect(
      executeRun(c.id, { actorId: null, claimWhere: { status: "DRAFT" }, statusUpdate: { status: "SENT" } }),
    ).rejects.toThrow(/already dispatched/i);
  });

  it("two concurrent send-now calls dispatch the audience exactly once", async () => {
    // A double-clicked "send now", or a manual send racing the cron drainer,
    // must enqueue the audience once. Two recipients widen the overlap window
    // and make a double-send obvious (2 logs, not 4).
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    const c = await createDraft(null, "DoubleClick");
    await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>Hi {{ firstName }}</p>", audience: ALL_ACTIVE });

    const results = await Promise.allSettled([
      sendCampaignNow(null, c.id, {}),
      sendCampaignNow(null, c.id, {}),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);

    const runs = await prisma.emailCampaignRun.findMany({ where: { campaignId: c.id } });
    expect(runs.length).toBe(1);
    const logs = await prisma.emailLog.findMany({ where: { template: "campaign" } });
    expect(logs.length).toBe(2);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
  });

  it("commits the claim before enqueuing, so an enqueue failure does not re-dispatch (F1)", async () => {
    // F1: the claim (status flip + run row) commits in a short tx BEFORE the
    // recipient enqueue, which runs outside it. This bounds the tx so a large
    // fan-out can't exceed the interactive-tx timeout and roll the claim back --
    // which for a SCHEDULED/RECURRING campaign would otherwise re-dispatch and
    // fail identically every cron tick forever. The deliberate trade-off: an
    // enqueue failure leaves the campaign marked SENT rather than reverting.
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Flaky");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") });

    const spy = vi.spyOn(sendModule, "queueEmails").mockRejectedValueOnce(new Error("enqueue down"));
    try {
      await expect(
        executeRun(c.id, { actorId: null, claimWhere: { status: "SCHEDULED" }, statusUpdate: { status: "SENT", nextRunAt: null } }),
      ).rejects.toThrow(/enqueue down/);
    } finally {
      spy.mockRestore();
    }
    // The claim committed independently, so the campaign is SENT and its run row
    // exists -- it will NOT be re-selected and time out again on the next tick.
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
    expect(await prisma.emailCampaignRun.count({ where: { campaignId: c.id } })).toBe(1);
  });

  it("cancel refuses a non-scheduled campaign", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam2@example.com", status: "ACTIVE" } });
    const c = await createDraft(null, "Sent3");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await sendCampaignNow(null, c.id, {}); // SENT
    await expect(cancelCampaign(null, c.id)).rejects.toThrow(/scheduled or recurring/i);
  });
});

describe("campaign scheduling", () => {
  it("schedules a one-time send and sets SCHEDULED + nextRunAt = scheduledAt", async () => {
    await activePerson("Later Recipient", "later@example.com");
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

  it("rejects a recurring cadence finer than the dispatch interval (audit #36)", async () => {
    const c = await createDraft(null, "TooFine");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "*/5 * * * *" }, new Date("2026-06-10T12:00:00Z")),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("requires confirmation to schedule a large-audience campaign, like sendCampaignNow (audit #39)", async () => {
    for (let i = 0; i < 26; i++) await activePerson(`Person ${i}`, `p${i}@example.com`);
    const c = await createDraft(null, "Big");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    const at = new Date("2030-01-01T12:00:00Z");

    // Without a matching confirmCount the schedule is blocked, carrying the count.
    let expected = 0;
    try {
      await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: at });
    } catch (err) {
      if (!(err instanceof CampaignConfirmationError)) throw err;
      expected = err.expected;
    }
    expect(expected).toBeGreaterThan(25);

    // Confirming the resolved count permits it.
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: at }, undefined, { confirmCount: expected });
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SCHEDULED");
  });

  it("refuses to schedule a campaign with a blank subject", async () => {
    const c = await createDraft(null, "NoSubjectSched");
    await updateCampaign(null, c.id, { subject: "", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2030-01-01T00:00:00Z") }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("cancel sets CANCELLED", async () => {
    await activePerson("Stop Recipient", "stop@example.com");
    const c = await createDraft(null, "Stop");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2030-01-01T00:00:00Z") });
    await cancelCampaign(null, c.id);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("CANCELLED");
  });

  it("refuses a one-off send/schedule to an empty audience, but allows recurring (zero-recipient guard)", async () => {
    // No active persons seeded, so ALL_ACTIVE resolves to nobody.
    const c = await createDraft(null, "Empty");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    // An immediate send to nobody would burn the campaign to terminal SENT.
    await expect(sendCampaignNow(null, c.id, {})).rejects.toBeInstanceOf(CampaignValidationError);
    // A one-off SCHEDULED send is the same unrecoverable mistake.
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2030-01-01T00:00:00Z") }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
    // Recurring is exempt: its audience is resolved live at each run, so zero-now is legitimate.
    await scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "0 13 * * *" }, new Date("2026-06-10T12:00:00Z"));
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("ACTIVE");
  });
});
