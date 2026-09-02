import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createDraft, updateCampaign, previewAudience, sendCampaignNow,
  scheduleCampaign, cancelCampaign, executeRun, listCampaigns, countAudienceNodes,
  CampaignValidationError, CampaignConfirmationError,
} from "./service";
import { MAX_COUNTED_NODES } from "@/platform/email/audience/resolve";
import type { Audience } from "@/platform/email/audience/types";
import * as audienceResolve from "@/platform/email/audience/resolve";
import * as sendModule from "@/platform/email/send";
import { createScope, grantScope } from "@/platform/email/audience/scopes";
import * as scopes from "@/platform/email/audience/scopes";
import * as rbac from "@/platform/rbac/engine";
import { assertMayActOnScope, resolveCampaignAudience, CampaignScopeError } from "./service";

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
    await expect(sendCampaignNow(null, c.id, {})).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("rejects editing a campaign that has already been sent", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Locked");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await sendCampaignNow(null, c.id, {});
    await expect(
      updateCampaign(null, c.id, { subject: "s2", body: "<p>x</p>", audience: ALL_ACTIVE }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
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
    await scheduleCampaign(
      null,
      c.id,
      { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") },
      new Date("2026-06-10T11:00:00Z"),
    );

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
    await expect(cancelCampaign(null, c.id)).rejects.toBeInstanceOf(CampaignValidationError);
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

  it("refuses a send time in the past, so a mistyped date cannot blast on the next tick", async () => {
    // The incident this guards: one campaign was scheduled for 6:30pm and another
    // for "8am", but with the date left on the current day rather than tomorrow.
    // The 8am row was therefore already ten hours due, and dispatchDueCampaigns
    // (nextRunAt <= now) sent BOTH on the 6:30pm tick.
    await activePerson("Past Recipient", "past@example.com");
    const c = await createDraft(null, "Backdated");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    const now = new Date("2026-06-10T22:30:00Z");

    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") }, now),
    ).rejects.toBeInstanceOf(CampaignValidationError);
    // Refused outright: still an editable DRAFT, never a SCHEDULED row sitting due.
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.nextRunAt).toBeNull();

    // "Now" itself is not a schedule either -- it would go out on the next tick.
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: now }, now),
    ).rejects.toBeInstanceOf(CampaignValidationError);

    // A minute into the future is accepted, so the guard is not off by a tick.
    await scheduleCampaign(
      null,
      c.id,
      { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T22:31:00Z") },
      now,
    );
    const scheduled = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(scheduled.status).toBe("SCHEDULED");
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

describe("campaign scope authorization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function scopedSetup() {
    const sender = await prisma.person.create({ data: { name: "Sender" } });
    const scope = await createScope(null, {
      name: "Active only",
      audience: {
        recordType: "PERSON",
        match: "ALL",
        conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
      },
    });
    return { sender, scope };
  }

  it("lets an unrestricted sender send with no scope", async () => {
    const admin = await prisma.person.create({ data: { name: "Admin" } });
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
    await expect(assertMayActOnScope(admin.id, null)).resolves.toBeNull();
  });

  it("refuses an unscoped send from a scoped-only sender", async () => {
    const { sender } = await scopedSetup();
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    await expect(assertMayActOnScope(sender.id, null)).rejects.toBeInstanceOf(CampaignScopeError);
  });

  it("refuses a scope the sender was not granted", async () => {
    const { sender, scope } = await scopedSetup();
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    await expect(assertMayActOnScope(sender.id, scope.id)).rejects.toBeInstanceOf(CampaignScopeError);
  });

  it("allows a scope the sender was granted", async () => {
    const { sender, scope } = await scopedSetup();
    await grantScope(null, scope.id, { personId: sender.id });
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    const resolved = await assertMayActOnScope(sender.id, scope.id);
    expect(resolved?.id).toBe(scope.id);
  });

  it("lets an unrestricted sender use any scope without a grant", async () => {
    const { sender, scope } = await scopedSetup();
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
    expect((await assertMayActOnScope(sender.id, scope.id))?.id).toBe(scope.id);
  });

  it("refuses a sender holding neither permission, even with a scope grant", async () => {
    const { sender, scope } = await scopedSetup();
    await grantScope(null, scope.id, { personId: sender.id });
    vi.spyOn(rbac, "can").mockResolvedValue(false);
    await expect(assertMayActOnScope(sender.id, scope.id)).rejects.toBeInstanceOf(CampaignScopeError);
  });

  it("resolves a scoped campaign's audience through its scope", async () => {
    await prisma.person.create({ data: { name: "Yes", contactEmail: "yes@x.com", status: "ACTIVE" } });
    await prisma.person.create({ data: { name: "No", contactEmail: "no@x.com", status: "OFFBOARDED" } });
    const { scope } = await scopedSetup();
    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: { recordType: "PERSON", match: "ALL", conditions: [{ field: "name", op: "isNotEmpty" }] },
      scopeId: scope.id,
      sendOncePerPerson: false,
    });
    expect(recipients.map((r) => r.email)).toEqual(["yes@x.com"]);
  });

  // A campaign scheduled under a scope that is later deleted must not fall back
  // to unscoped. It has to resolve to nobody.
  it("resolves to nobody when the referenced scope has vanished", async () => {
    await prisma.person.create({ data: { name: "Yes", contactEmail: "yes@x.com", status: "ACTIVE" } });
    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: { recordType: "PERSON", match: "ALL", conditions: [{ field: "name", op: "isNotEmpty" }] },
      scopeId: "scope-that-does-not-exist",
      sendOncePerPerson: false,
    });
    expect(recipients).toEqual([]);
  });
});

describe("listCampaigns scope filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an unrestricted sender every campaign regardless of scope", async () => {
    const admin = await prisma.person.create({ data: { name: "Admin" } });
    const scope = await createScope(null, { name: "Dept scope", audience: ALL_ACTIVE });
    await createDraft(null, "Unscoped", { scopeId: null });
    await createDraft(null, "Scoped", { scopeId: scope.id });
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
    const campaigns = await listCampaigns(admin.id);
    expect(campaigns.map((c) => c.name).sort()).toEqual(["Scoped", "Unscoped"]);
  });

  it("shows a scoped sender only campaigns bound to a scope they were granted", async () => {
    const sender = await prisma.person.create({ data: { name: "Sender" } });
    const mine = await createScope(null, { name: "Mine", audience: ALL_ACTIVE });
    const notMine = await createScope(null, { name: "Not mine", audience: ALL_ACTIVE });
    await grantScope(null, mine.id, { personId: sender.id });
    await createDraft(null, "My campaign", { scopeId: mine.id });
    await createDraft(null, "Someone else's campaign", { scopeId: notMine.id });
    // Unscoped campaigns are the send-all case: assertMayActOnScope refuses a
    // scoped-only sender a null scope, so the list must exclude them too.
    await createDraft(null, "Unscoped campaign", { scopeId: null });
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    const campaigns = await listCampaigns(sender.id);
    expect(campaigns.map((c) => c.name)).toEqual(["My campaign"]);
  });

  it("shows a scoped sender with no scope grants an empty list", async () => {
    const sender = await prisma.person.create({ data: { name: "Ungranted sender" } });
    const scope = await createScope(null, { name: "Somebody else's scope", audience: ALL_ACTIVE });
    await createDraft(null, "Not visible", { scopeId: scope.id });
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    const campaigns = await listCampaigns(sender.id);
    expect(campaigns).toEqual([]);
  });
});

describe("send-once per campaign", () => {
  // Sets the campaign ACTIVE directly (bypassing scheduleCampaign, which this
  // behavior does not depend on) so executeRun can be called twice with a
  // claimWhere/statusUpdate pair that never changes status -- both claims
  // match, so both runs actually execute.
  async function activeCampaign(sendOncePerPerson: boolean) {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Recurring digest");
    await updateCampaign(null, c.id, {
      subject: "Hi {{ firstName }}",
      body: "<p>Hi {{ firstName }}</p>",
      audience: ALL_ACTIVE,
    });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "ACTIVE", sendOncePerPerson } });
    return c.id;
  }

  async function runTwice(campaignId: string) {
    await executeRun(campaignId, { actorId: null, claimWhere: { status: "ACTIVE" }, statusUpdate: { lastRunAt: new Date() } });
    await executeRun(campaignId, { actorId: null, claimWhere: { status: "ACTIVE" }, statusUpdate: { lastRunAt: new Date() } });
  }

  it("mails each person once across runs when sendOncePerPerson is set", async () => {
    const id = await activeCampaign(true);
    await runTwice(id);
    const logs = await prisma.emailLog.findMany({ where: { toEmail: "sam@example.com" } });
    expect(logs.length).toBe(1);
  });

  it("mails again on the next run when the flag is off", async () => {
    const id = await activeCampaign(false);
    await runTwice(id);
    const logs = await prisma.emailLog.findMany({ where: { toEmail: "sam@example.com" } });
    expect(logs.length).toBe(2);
  });

  // Folded in from Task 7's review: sendOncePerPerson had no test composed with
  // a scope, even though that composition sits directly over the security-
  // critical property. Two runs of a scoped, sendOncePerPerson campaign must
  // still respect the scope on BOTH runs, and mail the in-scope person once.
  it("bounds a sendOncePerPerson scoped campaign by scope on every run, and mails nobody twice", async () => {
    const scope = await createScope(null, {
      name: "Active only (send-once)",
      audience: {
        recordType: "PERSON",
        match: "ALL",
        conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
      },
    });
    await activePerson("In Scope", "inscope@example.com");
    await prisma.person.create({
      data: { name: "Out Of Scope", contactEmail: "outscope@example.com", status: "OFFBOARDED" },
    });

    const c = await createDraft(null, "Scoped digest", { scopeId: scope.id });
    await updateCampaign(null, c.id, {
      subject: "Hi {{ firstName }}",
      body: "<p>Hi {{ firstName }}</p>",
      // Matches everyone regardless of status; only the scope should narrow it.
      audience: { recordType: "PERSON", match: "ALL", conditions: [{ field: "name", op: "isNotEmpty" }] },
    });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { status: "ACTIVE", sendOncePerPerson: true },
    });

    await runTwice(c.id);

    const inScopeLogs = await prisma.emailLog.findMany({ where: { toEmail: "inscope@example.com" } });
    expect(inScopeLogs.length).toBe(1);
    const outOfScopeLogs = await prisma.emailLog.findMany({ where: { toEmail: "outscope@example.com" } });
    expect(outOfScopeLogs.length).toBe(0);
  });
});

describe("manual include, exclude, and pasted recipient lists", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function scopedActiveOnly() {
    return createScope(null, {
      name: "Active only (manual lists)",
      audience: {
        recordType: "PERSON",
        match: "ALL",
        conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
      },
    });
  }

  // An audience with no conditions compiles to MATCH_NOBODY (see compileGroup
  // in audience/compile.ts), so this fixture isolates exactly what the manual
  // lists themselves reach -- nothing comes from the conditions.
  const MATCH_NOBODY_AUDIENCE = {
    recordType: "PERSON" as const,
    match: "ALL" as const,
    conditions: [],
  };

  // Load-bearing: the included person is deliberately paired with a SECOND
  // person outside the scope. A fixture where the included person happens to
  // be inside the scope anyway would pass under both a correct implementation
  // and a bypass that unions the include list on top of the scope instead of
  // inside it -- this pairing is what makes the two outcomes differ.
  it("an include list is intersected with scope: admits the in-scope person, blocks the out-of-scope one", async () => {
    const scope = await scopedActiveOnly();
    const inScope = await activePerson("In Scope", "in-scope@example.com");
    const outOfScope = await prisma.person.create({
      data: { name: "Out Of Scope", contactEmail: "out-of-scope@example.com", status: "OFFBOARDED" },
    });

    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: MATCH_NOBODY_AUDIENCE,
      scopeId: scope.id,
      sendOncePerPerson: false,
      includePersonIds: [inScope.id, outOfScope.id],
    });

    expect(recipients.map((r) => r.recordId)).toEqual([inScope.id]);
  });

  it("a pasted address list is intersected with scope: admits the in-scope address, blocks the out-of-scope one", async () => {
    const scope = await scopedActiveOnly();
    const inScope = await activePerson("In Scope", "in-scope@example.com");
    await prisma.person.create({
      data: { name: "Out Of Scope", contactEmail: "out-of-scope@example.com", status: "OFFBOARDED" },
    });

    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: MATCH_NOBODY_AUDIENCE,
      scopeId: scope.id,
      sendOncePerPerson: false,
      pastedEmails: ["in-scope@example.com", "out-of-scope@example.com"],
    });

    expect(recipients.map((r) => r.recordId)).toEqual([inScope.id]);
  });

  it("exclude removes someone the conditions matched", async () => {
    const scope = await scopedActiveOnly();
    const person = await activePerson("Matched", "matched@example.com");

    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: ALL_ACTIVE,
      scopeId: scope.id,
      sendOncePerPerson: false,
      excludePersonIds: [person.id],
    });

    expect(recipients).toEqual([]);
  });

  it("exclude overrides an explicit include of the same person", async () => {
    const scope = await scopedActiveOnly();
    const person = await activePerson("Both listed", "both@example.com");

    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: MATCH_NOBODY_AUDIENCE,
      scopeId: scope.id,
      sendOncePerPerson: false,
      includePersonIds: [person.id],
      excludePersonIds: [person.id],
    });

    expect(recipients).toEqual([]);
  });

  it("a pasted address matching no person is ignored without crashing or a phantom recipient", async () => {
    const scope = await scopedActiveOnly();
    const person = await activePerson("Real Match", "real@example.com");

    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: ALL_ACTIVE,
      scopeId: scope.id,
      sendOncePerPerson: false,
      pastedEmails: ["nobody-by-this-address@example.com"],
    });

    expect(recipients.map((r) => r.recordId)).toEqual([person.id]);
  });

  it("resolves a pasted address case-insensitively against the stored contactEmail", async () => {
    const scope = await scopedActiveOnly();
    const person = await activePerson("Casing", "casing@example.com");

    const { recipients } = await resolveCampaignAudience({
      id: "n/a",
      audienceJson: MATCH_NOBODY_AUDIENCE,
      scopeId: scope.id,
      sendOncePerPerson: false,
      pastedEmails: ["CASING@EXAMPLE.COM"],
    });

    expect(recipients.map((r) => r.recordId)).toEqual([person.id]);
  });
});

// ---------------------------------------------------------------------------
// Per-node match counts
//
// Every OTHER action in this service resolves an audience already stored in the
// database. countAudienceNodes is the one that takes a CLIENT-SUPPLIED tree,
// because its whole job is to count what the sender is editing before it is
// saved. That makes it the only new attack surface here, and the scope test is
// deliberately the first one in this block: a count computed without the
// campaign's scope leaks the size and shape of rosters the sender may not mail,
// and because the counts are live and per-node a sender could binary-search the
// directory by editing conditions and watching the numbers move.
// ---------------------------------------------------------------------------
describe("countAudienceNodes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function activeOnlyScope(name: string) {
    return createScope(null, {
      name,
      audience: {
        recordType: "PERSON",
        match: "ALL",
        conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
      },
    });
  }

  const NAMED = { field: "name", op: "isNotEmpty" as const };

  it("counts each node against the campaign's scope, not the whole roster", async () => {
    const scope = await activeOnlyScope("Active only (counts)");
    await activePerson("In Scope", "in-scope@example.com");
    // OFFBOARDED, so outside the scope, but they satisfy the campaign's own
    // condition (they have a name). A count that skipped the scope would report
    // 2 and tell a scoped sender exactly how many people they cannot mail.
    await prisma.person.create({
      data: { name: "Out Of Scope", contactEmail: "out-of-scope@example.com", status: "OFFBOARDED" },
    });

    const c = await createDraft(null, "Scoped counts", { scopeId: scope.id });
    const counts = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ALL",
      conditions: [NAMED],
    });

    expect(counts["0"]).toBe(1);
    expect(counts.root).toBe(1);
  });

  // The attack the client-supplied audience opens: the sender posts a tree
  // crafted to match the whole directory rather than the one they are editing.
  // Every node's count must still come back bounded by the campaign row's own
  // scope, the NONE group included -- that is the one node type compiling to
  // `NOT { OR: children }`, and it has already produced three send-all bugs on
  // this branch by silently inverting to match everybody.
  it("bounds a client-supplied match-everyone audience by the campaign's scope", async () => {
    const scope = await activeOnlyScope("Active only (attack)");
    await activePerson("Active One", "a1@example.com");
    await activePerson("Active Two", "a2@example.com");
    for (const n of ["GoneOne", "GoneTwo", "GoneThree"]) {
      await prisma.person.create({
        data: { name: n, contactEmail: `${n}@example.com`, status: "OFFBOARDED" },
      });
    }

    const c = await createDraft(null, "Attack counts", { scopeId: scope.id });
    const counts = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ANY",
      conditions: [
        // "has a name" OR "has no name" is every Person row in the table.
        NAMED,
        { field: "name", op: "isEmpty" },
        // NOT (status = ACTIVE): every OFFBOARDED person, i.e. precisely the
        // rows the scope exists to hide.
        { match: "NONE", children: [{ field: "status", op: "eq", value: "ACTIVE" }] },
      ],
    });

    expect(counts.root).toBe(2);
    expect(counts["0"]).toBe(2);
    expect(counts["1"]).toBe(0);
    expect(counts["2"]).toBe(0);
    expect(counts["2.0"]).toBe(2);
  });

  // EmailCampaign.scopeId is `onDelete: Restrict`, so a stored campaign cannot
  // currently reference a scope row that is gone; the lookup is stubbed to
  // produce the state directly. The branch is still worth pinning, because the
  // day that constraint changes the wrong fallback here would silently turn a
  // deleted boundary into a full-directory readout, which is exactly what
  // resolveCampaignAudience refuses for a real send.
  it("counts nobody when the campaign's scope can no longer be resolved", async () => {
    const scope = await activeOnlyScope("Active only (vanishing)");
    await activePerson("Still Here", "still@example.com");
    const c = await createDraft(null, "Orphaned scope", { scopeId: scope.id });

    vi.spyOn(scopes, "getScope").mockResolvedValue(null);
    const counts = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ALL",
      conditions: [NAMED],
    });
    expect(counts.root).toBe(0);
    expect(counts["0"]).toBe(0);
  });

  it("returns a count for every node including nested groups and the root", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    await activePerson("Kim Ng", "kim@example.com");
    await prisma.person.create({
      data: { name: "Sam Retired", contactEmail: "samr@example.com", status: "OFFBOARDED" },
    });

    const c = await createDraft(null, "Nested counts", { scopeId: null });
    const counts = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        {
          match: "ANY",
          children: [
            { field: "name", op: "contains", value: "Sam" },
            { field: "name", op: "contains", value: "Pat" },
          ],
        },
      ],
    });

    // Every key holds a DIFFERENT number on purpose: a map keyed by the wrong
    // path, or one that reused a parent's count for its children, would still
    // have to land on the right value five times to pass.
    expect(counts).toEqual({ root: 2, "0": 3, "1": 3, "1.0": 2, "1.1": 1 });
  });

  it("returns zero for an empty group rather than the whole roster", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    await activePerson("Kim Ng", "kim@example.com");

    const c = await createDraft(null, "Empty group", { scopeId: null });
    const counts = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        // An empty NONE is the sharp version: compiled naively it is
        // `NOT { OR: [] }`, which is vacuously true for every Person row.
        { match: "NONE", children: [] },
      ],
    });

    expect(counts["1"]).toBe(0);
    expect(counts["0"]).toBe(3);
    expect(counts.root).toBe(0);
  });

  // The decision this pins: a NONE group reports what its OWN compiled fragment
  // matches (everyone matching none of its children), not the set it removes.
  // The number is therefore larger than the audience it sits in, which is the
  // point -- it makes the widening visible instead of hiding it behind a
  // reassuringly small number.
  it("counts a NONE group as its own compiled fragment, everyone matching no child", async () => {
    // Load-bearing fixture: exactly ONE person matches the NONE group's child
    // and TWO match none of them. The two readings of "the group's count" -- its
    // own fragment (2) versus the set it removes (1) -- therefore land on
    // different numbers. An earlier fixture had two Sams and passed under both,
    // which is no test of the decision at all.
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    await prisma.person.create({
      data: { name: "Kim Retired", contactEmail: "kimr@example.com", status: "OFFBOARDED" },
    });

    const c = await createDraft(null, "None group", { scopeId: null });
    const counts = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { match: "NONE", children: [{ field: "name", op: "contains", value: "Sam" }] },
      ],
    });

    // Pat Lee and Kim Retired match no child of the NONE group.
    expect(counts["1"]).toBe(2);
    // ... while the audience the group sits in is just Pat Lee.
    expect(counts.root).toBe(1);
  });

  // The root count is not a derived aggregate over its children: it is the
  // scoped resolution of the whole tree, which is why it can be checked against
  // the preview -- but only for a campaign where nothing ELSE moves the roll.
  // The name is scoped to that case on purpose; the test below pins the
  // divergence that makes the general claim false.
  it("reports a root count equal to the preview for a fresh draft with no manual lists or prior runs", async () => {
    const scope = await activeOnlyScope("Active only (root)");
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    await prisma.person.create({
      data: { name: "Gone", contactEmail: "gone@example.com", status: "OFFBOARDED" },
    });

    const audience = {
      recordType: "PERSON" as const,
      match: "ALL" as const,
      conditions: [NAMED],
    };
    const c = await createDraft(null, "Root equals preview", { scopeId: scope.id });
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience });

    const counts = await countAudienceNodes(c.id, audience);
    expect(counts.root).toBe((await previewAudience(c.id)).count);
  });

  // The counts are of people the CONDITIONS match, which is not the same as the
  // people a send would reach, and the gap is reachable today because the
  // send-once toggle is already exposed in Timing. Pinned rather than left
  // implicit: `root` legitimately exceeding the preview is the documented
  // contract, so a future change that "fixed" it by folding the already-mailed
  // filter into the counts would be changing the contract, not repairing a bug.
  it("reports a root count ABOVE the preview once a send-once campaign has already mailed people", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");

    const audience = {
      recordType: "PERSON" as const,
      match: "ALL" as const,
      conditions: [NAMED],
    };
    const c = await createDraft(null, "Send once", { scopeId: null });
    await updateCampaign(null, c.id, {
      subject: "s",
      body: "b",
      audience,
      sendOncePerPerson: true,
    });

    // Both people match, and both get mailed on the first run.
    expect((await countAudienceNodes(c.id, audience)).root).toBe(2);
    expect(await sendCampaignNow(null, c.id, { confirmCount: 2 })).toMatchObject({
      recipientCount: 2,
    });

    // The preview now excludes them; the node count still reports what the
    // conditions match, because a count query cannot see prior EmailLog rows.
    expect((await previewAudience(c.id)).count).toBe(0);
    expect((await countAudienceNodes(c.id, audience)).root).toBe(2);
  });

  it("refuses a tree past the node budget and returns an empty map", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Huge tree", { scopeId: null });
    const cond = { field: "name", op: "isNotEmpty" as const };

    // The budget counts the root alongside every child, so a tree of exactly
    // MAX_COUNTED_NODES - 1 conditions is the largest one still counted.
    const atBudget = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ANY",
      conditions: Array.from({ length: MAX_COUNTED_NODES - 1 }, () => cond),
    });
    expect(Object.keys(atBudget).length).toBe(MAX_COUNTED_NODES);

    const overBudget = await countAudienceNodes(c.id, {
      recordType: "PERSON",
      match: "ANY",
      conditions: Array.from({ length: MAX_COUNTED_NODES }, () => cond),
    });
    expect(overBudget).toEqual({});
  });

  it("rejects a malformed client-supplied audience instead of compiling it", async () => {
    const c = await createDraft(null, "Malformed", { scopeId: null });
    await expect(
      countAudienceNodes(c.id, {
        recordType: "APPLICANT",
        match: "ALL",
        conditions: [],
      } as unknown as Audience),
    ).rejects.toBeInstanceOf(CampaignValidationError);
    await expect(
      countAudienceNodes(c.id, {
        recordType: "PERSON",
        match: "ALL",
        conditions: [{ nope: 1 }],
      } as unknown as Audience),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });
});
