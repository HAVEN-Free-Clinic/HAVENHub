import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createDraft, updateCampaign, previewAudience, sendCampaignNow,
  scheduleCampaign, cancelCampaign, executeRun, listCampaigns, countAudienceNodes,
  searchAudiencePeople, editManualLists, testSend, MAX_PASTED_EMAILS,
  CampaignValidationError, CampaignConfirmationError,
} from "./service";
import type { AudiencePreview } from "./service";
import { MAX_COUNTED_NODES, PERSON_SEARCH_LIMIT } from "@/platform/email/audience/resolve";
import type { Audience } from "@/platform/email/audience/types";
import * as audienceResolve from "@/platform/email/audience/resolve";
import * as sendModule from "@/platform/email/send";
import { createScope, grantScope, updateScope } from "@/platform/email/audience/scopes";
import * as scopes from "@/platform/email/audience/scopes";
import * as rbac from "@/platform/rbac/engine";
import { assertMayActOnScope, resolveCampaignAudience, CampaignScopeError } from "./service";
import { senderIdentitiesForCampaign } from "./service";
import {
  issueSendingIdentity,
  revokeSendingIdentity,
  senderTestFrom,
  SenderIdentityError,
} from "@/platform/email/sender-identity";
import { saveSenderRule } from "@/platform/email/sender-rules";

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

  // isAudience and enumerateNodes both recurse, and both run before
  // MAX_COUNTED_NODES applies, so without an iterative guard in front of them a
  // deeply nested tree is a stack overflow rather than a rejection. Reachable
  // only by an authenticated sender hand-posting to their own campaign, so the
  // damage is a 500 they caused themselves, but it is unbounded and the guard
  // is cheap.
  it("rejects a tree nested past the depth limit instead of overflowing on it", async () => {
    const c = await createDraft(null, "Deep", { scopeId: null });

    // Deep enough to blow a real call stack, built iteratively so the FIXTURE
    // is not the thing that overflows.
    let node: unknown = { field: "name", op: "isNotEmpty" };
    for (let i = 0; i < 20000; i++) node = { match: "ALL", children: [node] };
    const deep = { recordType: "PERSON", match: "ALL", conditions: [node] } as unknown as Audience;

    await expect(countAudienceNodes(c.id, deep)).rejects.toBeInstanceOf(CampaignValidationError);

    // And the limit is not so tight that ordinary nesting trips it: the builder
    // can nest groups, and a tree well inside the limit still counts.
    let ok: unknown = { field: "name", op: "isNotEmpty" };
    for (let i = 0; i < 5; i++) ok = { match: "ALL", children: [ok] };
    const shallow = { recordType: "PERSON", match: "ALL", conditions: [ok] } as unknown as Audience;
    await expect(countAudienceNodes(c.id, shallow)).resolves.toBeTypeOf("object");
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

// ---------------------------------------------------------------------------
// Recipient preview, manual-list surfacing, and the scoped person search
//
// Two of these surfaces are information oracles if built the obvious way, so
// both scope tests come FIRST, ahead of every labelling test:
//
// 1. searchAudiencePeople. A search over all people would let a scoped sender
//    enumerate the whole directory by typing letters, even though the send that
//    follows is still scope-filtered. Learning who exists is itself the leak.
//
// 2. The unresolved-pasted-address report. If an address belonging to a real
//    person OUTSIDE the sender's scope were reported any differently from one
//    belonging to nobody at all, the sender would hold an existence oracle over
//    the whole directory, one address at a time. The test below asserts on the
//    entire user-visible result, not merely on membership in a list.
// ---------------------------------------------------------------------------
describe("recipient preview and the scoped person search", () => {
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

  // No conditions compiles to MATCH_NOBODY (compileGroup in audience/compile.ts),
  // so a campaign carrying this audience shows exactly what the manual lists
  // themselves reach and nothing that leaked in from the conditions.
  const MATCH_NOBODY: Audience = { recordType: "PERSON", match: "ALL", conditions: [] };

  it("the person search returns nobody outside the campaign's scope", async () => {
    const scope = await activeOnlyScope("Active only (search)");
    // Deliberately paired: both people answer the SAME query, and neither name
    // is a substring of the other. A fixture where only the in-scope person
    // could match would pass just as well against a search that ignored the
    // scope entirely.
    const inScope = await activePerson("Rivera Sam", "sam@example.com");
    await prisma.person.create({
      data: { name: "Rivera Pat", contactEmail: "pat@example.com", status: "OFFBOARDED" },
    });

    const scoped = await createDraft(null, "Scoped search", { scopeId: scope.id });
    expect(await searchAudiencePeople(scoped.id, "Rivera")).toEqual([
      { personId: inScope.id, name: "Rivera Sam", email: "sam@example.com" },
    ]);
  });

  // The oracle the OUTPUT tests below cannot see. `resolveAudience(scope)` used
  // to sit inside `if (candidateIds.length > 0)`, and candidateIds is non-empty
  // iff a pasted address matched a Person row ANYWHERE in the directory. So the
  // two cases the unresolved report is careful to make identical in output did
  // measurably different work, and a scoped sender with a trivial baseline
  // audience could sample the difference by reloading the Audience tab.
  //
  // Counted rather than timed: a wall-clock assertion would be a flake, and the
  // property that actually matters is that the same queries run either way.
  it("runs the same scope resolve whether a pasted address matches a real out-of-scope person or nobody", async () => {
    const scope = await activeOnlyScope("Active only (timing)");
    await activePerson("In Scope", "in-scope@example.com");
    await prisma.person.create({
      data: {
        name: "Real But Unreachable",
        contactEmail: "real-outsider@example.com",
        status: "OFFBOARDED",
      },
    });

    async function resolveCallsFor(pasted: string): Promise<number> {
      const c = await createDraft(null, `Probe ${pasted}`, { scopeId: scope.id });
      await updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
      await prisma.emailCampaign.update({
        where: { id: c.id },
        data: { pastedEmails: [pasted] },
      });
      const spy = vi.spyOn(audienceResolve, "resolveAudience");
      await previewAudience(c.id);
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    }

    const withRealPerson = await resolveCallsFor("real-outsider@example.com");
    const withNobody = await resolveCallsFor("nobody-at-all@example.com");
    expect(withNobody).toBe(withRealPerson);
    // Named, not just compared: two paths that BOTH skipped the scope resolve
    // would be equal here and would be a scope bypass rather than a fix. Two is
    // the campaign's own resolve plus the scope's.
    expect(withRealPerson).toBe(2);
  });

  it("the person search finds nobody at all once the campaign's scope is gone", async () => {
    const scope = await activeOnlyScope("Active only (vanishing search)");
    await activePerson("Rivera Sam", "sam@example.com");
    const c = await createDraft(null, "Orphaned scope search", { scopeId: scope.id });

    vi.spyOn(scopes, "getScope").mockResolvedValue(null);
    expect(await searchAudiencePeople(c.id, "Rivera")).toEqual([]);
  });

  it("reports a pasted address belonging to an out-of-scope person identically to one belonging to nobody", async () => {
    const scope = await activeOnlyScope("Active only (oracle)");
    // The roll itself is identical in both campaigns, so any difference the
    // comparison finds comes from the pasted address alone.
    await activePerson("In Scope", "in-scope@example.com");
    await prisma.person.create({
      data: {
        name: "Real But Unreachable",
        contactEmail: "real-outsider@example.com",
        status: "OFFBOARDED",
      },
    });

    const REAL_OUTSIDER = "real-outsider@example.com";
    const NOBODY = "nobody-at-all@example.com";

    const withRealOutsider = await createDraft(null, "Probe A", { scopeId: scope.id });
    await updateCampaign(null, withRealOutsider.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
    await prisma.emailCampaign.update({
      where: { id: withRealOutsider.id },
      data: { pastedEmails: [REAL_OUTSIDER] },
    });

    const withNobody = await createDraft(null, "Probe B", { scopeId: scope.id });
    await updateCampaign(null, withNobody.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
    await prisma.emailCampaign.update({
      where: { id: withNobody.id },
      data: { pastedEmails: [NOBODY] },
    });

    const a = await previewAudience(withRealOutsider.id);
    const b = await previewAudience(withNobody.id);

    // Everything the sender can observe, with the pasted address itself masked.
    // If the two cases differed in ANY other way -- a different list, a
    // different count, a different roll, a different order, an extra field --
    // this comparison fails. Asserting only "both appear in unresolved" would
    // not: a report that tagged the out-of-scope one, or dropped it from the
    // list while still counting it, would pass that weaker check.
    const observable = (preview: AudiencePreview, pasted: string) => ({
      ...preview,
      unresolved: preview.unresolved.map((u) => (u === pasted ? "<the pasted address>" : u)),
    });
    expect(observable(a, REAL_OUTSIDER)).toEqual(observable(b, NOBODY));

    // And the shape they share is the one that really does report the address
    // back, so the equality above is not two empty reports agreeing.
    expect(a.unresolved).toEqual([REAL_OUTSIDER]);
    expect(b.unresolved).toEqual([NOBODY]);
  });

  it("does not put a pasted out-of-scope address into the roll, matching what a real send does", async () => {
    const scope = await activeOnlyScope("Active only (pasted roll)");
    const inScope = await activePerson("In Scope", "in-scope@example.com");
    await prisma.person.create({
      data: { name: "Out Of Scope", contactEmail: "out-of-scope@example.com", status: "OFFBOARDED" },
    });

    const c = await createDraft(null, "Pasted roll", { scopeId: scope.id });
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience: MATCH_NOBODY });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { pastedEmails: ["in-scope@example.com", "out-of-scope@example.com"] },
    });

    const preview = await previewAudience(c.id);
    expect(preview.sample.map((r) => r.personId)).toEqual([inScope.id]);
    expect(preview.count).toBe(1);
  });

  it("labels a condition match 'matched' and a manual addition 'included' or 'pasted'", async () => {
    // Scope: everyone with a name. The two manual additions are inside it but
    // OUTSIDE the campaign's own conditions, so each label has to come from the
    // list the person arrived on rather than from the condition match.
    const scope = await createScope(null, {
      name: "Everyone with a name",
      audience: {
        recordType: "PERSON",
        match: "ALL",
        conditions: [{ field: "name", op: "isNotEmpty" }],
      },
    });
    const matched = await activePerson("Anna Matched", "matched@example.com");
    const included = await prisma.person.create({
      data: { name: "Bea Included", contactEmail: "included@example.com", status: "OFFBOARDED" },
    });
    const pasted = await prisma.person.create({
      data: { name: "Cal Pasted", contactEmail: "pasted@example.com", status: "OFFBOARDED" },
    });
    // On BOTH manual lists. Neither route's removal alone would drop them, so
    // the label names the one the sender can see and act on: the paste box.
    // Removing that address then re-labels them "included", which is the panel
    // telling them a second entry exists.
    const both = await prisma.person.create({
      data: { name: "Dee Both", contactEmail: "both@example.com", status: "OFFBOARDED" },
    });

    const c = await createDraft(null, "Labels", { scopeId: scope.id });
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: {
        includePersonIds: [included.id, both.id],
        pastedEmails: ["pasted@example.com", "both@example.com"],
      },
    });

    const preview = await previewAudience(c.id);
    expect(preview.sample).toEqual([
      { personId: matched.id, name: "Anna Matched", email: "matched@example.com", reason: "matched" },
      { personId: included.id, name: "Bea Included", email: "included@example.com", reason: "included" },
      { personId: pasted.id, name: "Cal Pasted", email: "pasted@example.com", reason: "pasted" },
      { personId: both.id, name: "Dee Both", email: "both@example.com", reason: "pasted" },
    ]);

    // Drop the pasted half and the same person is now labelled "included": the
    // label always names a route that alone keeps them on the roll, and it
    // moves to the next one as routes are removed.
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { pastedEmails: ["pasted@example.com"] },
    });
    const after = await previewAudience(c.id);
    expect(after.sample.find((r) => r.personId === both.id)?.reason).toBe("included");
  });

  // The deliberate answer to "both a condition match AND an explicit include".
  // "matched" is the truthful one: the person is in the roll with the manual
  // entry deleted, and labelling them "included" would tell the sender that
  // removing it drops them, which is false.
  it("labels someone who is both a condition match and an explicit include 'matched'", async () => {
    const both = await activePerson("Both Ways", "both@example.com");

    const c = await createDraft(null, "Both ways", { scopeId: null });
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { includePersonIds: [both.id], pastedEmails: ["both@example.com"] },
    });

    const preview = await previewAudience(c.id);
    expect(preview.sample).toEqual([
      { personId: both.id, name: "Both Ways", email: "both@example.com", reason: "matched" },
    ]);
    // And the address is not ALSO reported back as unresolved: it reached the roll.
    expect(preview.unresolved).toEqual([]);
  });

  it("an exclude beats an explicit include of the same person, in the preview as in a send", async () => {
    const excluded = await activePerson("Excluded Person", "excluded@example.com");
    const kept = await activePerson("Kept Person", "kept@example.com");

    const c = await createDraft(null, "Exclude wins", { scopeId: null });
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { includePersonIds: [excluded.id], excludePersonIds: [excluded.id] },
    });

    const preview = await previewAudience(c.id);
    // The survivor is named as well as counted: a preview that returned nobody
    // at all would satisfy "the excluded person is gone" without proving the
    // exclude was targeted.
    expect(preview.sample).toEqual([
      { personId: kept.id, name: "Kept Person", email: "kept@example.com", reason: "matched" },
    ]);
    expect(preview.count).toBe(1);
  });

  it("surfaces how many matched people were dropped for having no email address", async () => {
    await activePerson("Has Email", "has@example.com");
    await prisma.person.create({ data: { name: "No Email At All", status: "ACTIVE" } });
    await prisma.person.create({ data: { name: "Blank Email", contactEmail: "   ", status: "ACTIVE" } });

    const c = await createDraft(null, "No email", { scopeId: null });
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE });

    const preview = await previewAudience(c.id);
    expect(preview.count).toBe(1);
    expect(preview.excludedNoEmail).toBe(2);
  });

  it("reports an unresolvable pasted address back rather than dropping it silently", async () => {
    const person = await activePerson("Real Match", "real@example.com");

    const c = await createDraft(null, "Typo", { scopeId: null });
    await updateCampaign(null, c.id, { subject: "s", body: "b", audience: ALL_ACTIVE });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { pastedEmails: ["  Typo@Example.com  ", "real@example.com"] },
    });

    const preview = await previewAudience(c.id);
    // Trimmed but not lower-cased: echoed back the way the sender typed it, so
    // they can find it in the box they pasted it into.
    expect(preview.unresolved).toEqual(["Typo@Example.com"]);
    expect(preview.sample.map((r) => r.personId)).toEqual([person.id]);
  });

  // The blank-address test has to be pushed into the QUERY rather than applied
  // to the rows that come back, or people with an unusable address fill the
  // result slots before anyone reachable is reached and the search reports
  // nothing while in-scope matches exist.
  //
  // Whitespace, not "": Person.contactEmail is @unique, so only ONE row can
  // hold the empty string and it could waste at most one slot. Whitespace-only
  // addresses are all DISTINCT values, so they can fill every slot -- and they
  // are the spelling of "blank" that no Prisma string filter can test for,
  // which is why the query has to ask the question a different way.
  it("does not let people with a blank address consume the search's result slots", async () => {
    await prisma.person.createMany({
      data: Array.from({ length: PERSON_SEARCH_LIMIT }, (_, i) => ({
        // Sorts before the real match, so under a filter applied after `take`
        // these are the only rows the query ever returns.
        name: `Aaa Rivera Blank ${String(i).padStart(2, "0")}`,
        contactEmail: " ".repeat(i + 1),
        status: "ACTIVE" as const,
      })),
    });
    const real = await activePerson("Zzz Rivera Sam", "sam@example.com");

    const c = await createDraft(null, "Blank slots", { scopeId: null });
    expect(await searchAudiencePeople(c.id, "Rivera")).toEqual([
      { personId: real.id, name: "Zzz Rivera Sam", email: "sam@example.com" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The manual lists' only writer.
//
// Tested at the service rather than left to the thin actions above it, unlike
// the seven older campaign actions whose services are already covered: this
// function is new, has four branches, and is the sole writer of
// excludePersonIds. The column it writes is computed from a union literal, so a
// swapped ternary type-checks, stays self-consistent, and makes Exclude append
// to the INCLUDE list -- mailing someone the sender deliberately removed, which
// a bulk send cannot take back.
// ---------------------------------------------------------------------------
describe("editManualLists", () => {
  it("an exclude writes the exclude column and leaves the include column alone", async () => {
    const person = await activePerson("Excluded", "excluded@example.com");
    const c = await createDraft(null, "Exclude write", { scopeId: null });

    await editManualLists(null, c.id, { op: "exclude", personId: person.id });

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    // Both columns asserted, in both directions: naming only the one that
    // should have changed would pass just as well if BOTH had.
    expect(after.excludePersonIds).toEqual([person.id]);
    expect(after.includePersonIds).toEqual([]);
  });

  it("an include writes the include column and leaves the exclude column alone", async () => {
    const person = await activePerson("Included", "included@example.com");
    const c = await createDraft(null, "Include write", { scopeId: null });

    await editManualLists(null, c.id, { op: "include", personId: person.id });

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.includePersonIds).toEqual([person.id]);
    expect(after.excludePersonIds).toEqual([]);
  });

  it("clearing the exclusions empties that column and nothing else", async () => {
    const a = await activePerson("A", "a@example.com");
    const b = await activePerson("B", "b@example.com");
    const c = await createDraft(null, "Clear", { scopeId: null });
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: {
        excludePersonIds: [a.id, b.id],
        includePersonIds: [a.id],
        pastedEmails: ["kept@example.com"],
      },
    });

    await editManualLists(null, c.id, { op: "clearExcluded" });

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.excludePersonIds).toEqual([]);
    expect(after.includePersonIds).toEqual([a.id]);
    expect(after.pastedEmails).toEqual(["kept@example.com"]);
  });

  it("normalises a pasted block and refuses one past the cap", async () => {
    const c = await createDraft(null, "Paste", { scopeId: null });

    await editManualLists(null, c.id, {
      op: "paste",
      emails: ["  Sam@Example.com  ", "", "sam@example.com", "pat@example.com"],
    });

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    // Trimmed, blanks dropped, deduped case-insensitively, and the sender's own
    // casing kept on the entry that survives.
    expect(after.pastedEmails).toEqual(["Sam@Example.com", "pat@example.com"]);

    await expect(
      editManualLists(null, c.id, {
        op: "paste",
        emails: Array.from({ length: MAX_PASTED_EMAILS + 1 }, (_, i) => `p${i}@example.com`),
      }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
    // Refused, not truncated: the previous block is still what is stored.
    const unchanged = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(unchanged.pastedEmails).toEqual(["Sam@Example.com", "pat@example.com"]);
  });

  // The only thing stopping a manual-list edit from silently changing who a
  // SCHEDULED campaign is about to mail.
  it("refuses to edit a campaign that is no longer a draft", async () => {
    const person = await activePerson("Locked", "locked@example.com");
    const c = await createDraft(null, "Scheduled", { scopeId: null });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "SCHEDULED" } });

    await expect(
      editManualLists(null, c.id, { op: "exclude", personId: person.id }),
    ).rejects.toBeInstanceOf(CampaignValidationError);

    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.excludePersonIds).toEqual([]);
  });
});

/**
 * Sender identity on a campaign: the authorization boundary at the seam the
 * compose form actually posts to, plus what one RUN goes out as.
 *
 * sender-identity.test.ts covers the resolution order in isolation. These cases
 * exist because the interesting failures are at the joins: a hand-crafted
 * fromEmail reaching updateCampaign, and an identity revoked in the window
 * between Save and Send.
 */
describe("campaign sending identity", () => {
  const SUBJECT = "Hello";
  const BODY = "<p>Hi</p>";

  async function scopedCampaign(scopeFromEmail: string | null) {
    const sender = await prisma.person.create({
      // A profile address on a Maileroo-signed clinic domain, deliberately: it
      // is the shape that used to be usable as a From, so every case below is
      // exercised against the dangerous version rather than a harmless one.
      data: { name: "Scoped Sender", contactEmail: "directors@havenfreeclinic.org", status: "ACTIVE" },
    });
    const scope = await createScope(null, {
      name: "Peds",
      audience: ALL_ACTIVE,
      ...(scopeFromEmail ? { fromEmail: scopeFromEmail } : {}),
    });
    await grantScope(null, scope.id, { personId: sender.id });
    const campaign = await createDraft(sender.id, "Newsletter", { scopeId: scope.id });
    return { sender, scope, campaign };
  }

  it("refuses a hand-crafted fromEmail that is not one of the sender's identities", async () => {
    // THE crafted request. A scoped sender holds outreach.send and a grant, so
    // they legitimately reach saveAction; the compose form offers them two
    // addresses and they POST a third:
    //
    //   fromEmail=dean%40yale.edu
    //
    // On yale.edu, which the allowlist carries, so nothing but the ownership
    // check can refuse it. Asserted at the SERVICE, not only at the action,
    // because the action is one caller and this has to hold standalone.
    const { sender, campaign } = await scopedCampaign("peds@havenfreeclinic.org");

    await expect(
      updateCampaign(sender.id, campaign.id, {
        subject: SUBJECT,
        body: BODY,
        audience: ALL_ACTIVE,
        fromEmail: "dean@yale.edu",
      }),
    ).rejects.toBeInstanceOf(SenderIdentityError);

    // Refused, not silently downgraded to the default: nothing was stored, and
    // the rest of the save did not land either.
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.fromEmail).toBeNull();
    expect(after.subject).toBe("");
  });

  it("stores an authorized choice with the chooser, and sends every recipient as it", async () => {
    const { sender, campaign } = await scopedCampaign("peds@havenfreeclinic.org");
    await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
    });
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");

    await updateCampaign(sender.id, campaign.id, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
      fromEmail: "recruitment@havenfreeclinic.org",
    });
    const stored = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.fromEmail).toBe("recruitment@havenfreeclinic.org");
    // Who chose it, which is who the enqueue-time re-check runs against.
    expect(stored.fromEmailSetById).toBe(sender.id);

    const res = await sendCampaignNow(sender.id, campaign.id, {});
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    // Three, not two: the sender is an ACTIVE person and so matches their own
    // audience. Every row, whoever it is addressed to, carries the one identity.
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.fromEmail === "recruitment@havenfreeclinic.org")).toBe(true);
    expect(logs.every((l) => l.fromName === "HAVEN Recruitment")).toBe(true);
  });

  it("falls back down the order when the chosen identity is revoked before the send", async () => {
    // The window that makes the enqueue-time re-resolve necessary at all: a
    // recurring campaign is dispatched by cron, with no actor, weeks after it
    // was composed.
    const { sender, campaign } = await scopedCampaign("peds@havenfreeclinic.org");
    const issued = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await activePerson("Sam Rivera", "sam@example.com");
    await updateCampaign(sender.id, campaign.id, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
      fromEmail: "recruitment@havenfreeclinic.org",
    });

    await revokeSendingIdentity(null, issued.id);

    const res = await sendCampaignNow(sender.id, campaign.id, {});
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    // NOT the revoked address, and not nothing either: the run falls back to the
    // scope identity, which an admin controls.
    expect(logs.length).toBeGreaterThan(0);
    expect([...new Set(logs.map((l) => l.fromEmail))]).toEqual(["peds@havenfreeclinic.org"]);
    // The stored choice is left alone. It is the record of what the sender asked
    // for, and re-issuing the address makes it live again without a re-save.
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.fromEmail).toBe("recruitment@havenfreeclinic.org");
  });

  it("falls back down the order when the chooser LOSES THE ROLE before the send", async () => {
    // The Task 3 window, and the same class of event as the revocation above: a
    // campaign composed under one set of claims, dispatched under another. Here
    // the identity is untouched and still live for everyone else in the role --
    // it is the CHOOSER who stopped being in it, weeks later, with nobody
    // touching the campaign.
    //
    // Nothing in the send path knows about roles. This works because the
    // enqueue-time re-resolve goes through availableSenderIdentities, which
    // expands roles live; a snapshot taken at Save would send as an address the
    // person may no longer use, and would look identical in every other test.
    const { sender, campaign } = await scopedCampaign("peds@havenfreeclinic.org");
    const successor = await activePerson("Successor", "successor@example.com");
    const editors = await prisma.role.create({ data: { name: "Editors" } });
    for (const p of [sender, successor]) {
      await prisma.roleAssignment.create({
        data: { roleId: editors.id, personId: p.id, termId: null },
      });
    }
    await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await activePerson("Sam Rivera", "sam@example.com");

    // The role is the ONLY thing that puts this address in front of them, so the
    // save proves the role route reaches the authorization check too.
    await updateCampaign(sender.id, campaign.id, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
      fromEmail: "recruitment@havenfreeclinic.org",
    });
    expect(
      (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).fromEmail,
    ).toBe("recruitment@havenfreeclinic.org");

    await prisma.roleAssignment.deleteMany({ where: { roleId: editors.id, personId: sender.id } });

    const res = await sendCampaignNow(sender.id, campaign.id, {});
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect(logs.length).toBeGreaterThan(0);
    // NOT the address they may no longer use. The fallback lands on the scope
    // identity, which is admin-controlled and which they COULD still have picked
    // at this moment -- it is drawn from the same freshly-resolved list.
    expect([...new Set(logs.map((l) => l.fromEmail))]).toEqual(["peds@havenfreeclinic.org"]);

    // The identity itself is untouched, and the successor still holds it. Only
    // the chooser's route to it went away, which is exactly what was asserted.
    expect(
      (await senderIdentitiesForCampaign(successor.id, campaign.id)).map((o) => o.address),
    ).toContain("recruitment@havenfreeclinic.org");
    // And the picker agrees with the send: the chooser is no longer offered it.
    expect(
      (await senderIdentitiesForCampaign(sender.id, campaign.id)).map((o) => o.address),
    ).toEqual(["peds@havenfreeclinic.org"]);
  });

  it("reads a blank or whitespace-only choice as CLEARED, not as a pin", async () => {
    // A whitespace-only value is truthy. Read as a choice, it would store
    // whatever the default resolves to today as an explicit pin, which then
    // survives the scope identity changing underneath it.
    const { sender, scope, campaign } = await scopedCampaign("peds@havenfreeclinic.org");
    await updateCampaign(sender.id, campaign.id, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
      fromEmail: "   ",
    });
    const stored = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.fromEmail).toBeNull();
    expect(stored.fromEmailSetById).toBeNull();

    // Which is what lets the scope identity keep governing when it changes.
    await updateScope(null, scope.id, {
      name: "Peds",
      audience: ALL_ACTIVE,
      fromEmail: "peds2@havenfreeclinic.org",
    });
    await activePerson("Sam Rivera", "sam@example.com");
    const res = await sendCampaignNow(sender.id, campaign.id, {});
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect([...new Set(logs.map((l) => l.fromEmail))]).toEqual(["peds2@havenfreeclinic.org"]);
  });

  it("uses the scope identity when the sender chose nothing", async () => {
    const { sender, campaign } = await scopedCampaign("peds@havenfreeclinic.org");
    await activePerson("Sam Rivera", "sam@example.com");
    await updateCampaign(sender.id, campaign.id, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
    });

    const res = await sendCampaignNow(sender.id, campaign.id, {});
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect(logs.length).toBeGreaterThan(0);
    expect([...new Set(logs.map((l) => l.fromEmail))]).toEqual(["peds@havenfreeclinic.org"]);
  });

  it("leaves a campaign with no resolvable identity on the template sender rules", async () => {
    // The pre-Phase-3 behaviour, which must survive: no scope identity, nothing
    // issued, and a creator whose contactEmail is not on a verified domain.
    const outsider = await prisma.person.create({
      data: { name: "Outsider", contactEmail: "outsider@gmail.com", status: "ACTIVE" },
    });
    await saveSenderRule(null, "CATEGORY", "campaign", { fromEmail: "rules@yale.edu" });
    const campaign = await createDraft(outsider.id, "Newsletter", { scopeId: null });
    await activePerson("Sam Rivera", "sam@example.com");
    await updateCampaign(outsider.id, campaign.id, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
    });

    const res = await sendCampaignNow(outsider.id, campaign.id, {});
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect(logs.length).toBeGreaterThan(0);
    expect([...new Set(logs.map((l) => l.fromEmail))]).toEqual(["rules@yale.edu"]);
  });

  it("offers the campaign's own scope identity, never another scope's", async () => {
    const { sender, campaign } = await scopedCampaign("peds@havenfreeclinic.org");
    await createScope(null, {
      name: "Executive",
      audience: ALL_ACTIVE,
      fromEmail: "exec@havenfreeclinic.org",
    });

    const options = await senderIdentitiesForCampaign(sender.id, campaign.id);
    // Only the bound scope's identity. Not the OTHER scope's, which is real and
    // admin-configured but belongs to a campaign this one is not, and not the
    // sender's own profile address, which is on a Maileroo-signed clinic domain
    // and would therefore have left as itself.
    expect(options.map((o) => o.address)).toEqual(["peds@havenfreeclinic.org"]);
  });

  it("refuses the sender's own profile address end to end, through the save seam", async () => {
    // The Critical from review round 1, at the seam the compose form posts to.
    // The sender sets their profile to an unclaimed clinic role address and
    // submits it as the campaign's From. Nothing is issued to them, so the only
    // claim behind it is "I typed it into my own profile".
    const { sender, campaign } = await scopedCampaign(null);
    await activePerson("Sam Rivera", "sam@example.com");

    expect(await senderIdentitiesForCampaign(sender.id, campaign.id)).toEqual([]);
    await expect(
      updateCampaign(sender.id, campaign.id, {
        subject: SUBJECT,
        body: BODY,
        audience: ALL_ACTIVE,
        fromEmail: "directors@havenfreeclinic.org",
      }),
    ).rejects.toBeInstanceOf(SenderIdentityError);

    // And with no claim at all, the run falls through to the template rules and
    // the global sender rather than quietly using the profile address.
    await updateCampaign(sender.id, campaign.id, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
    });
    const res = await sendCampaignNow(sender.id, campaign.id, {});
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect(logs.length).toBeGreaterThan(0);
    expect([...new Set(logs.map((l) => l.fromEmail))]).toEqual([null]);
  });
});

/**
 * The NAME a campaign run goes out under, next to the address.
 *
 * An admin-set display name wins; the sending person's name fills the gap. The
 * two admin layers are the scope's `fromName` and an issued identity's
 * `displayName`, and neither is overridden by whoever pressed Send: a role
 * address configured as "HAVEN Recruitment" keeps that institutional voice.
 *
 * WHICH PERSON is the part most easily got wrong, and it is asserted on its own
 * below. It is the one who CHOSE the identity (EmailCampaign.fromEmailSetById),
 * not the actor dispatching the run: a recurring campaign is dispatched by cron
 * with no actor at all, weeks after composition, and crediting the dispatcher
 * would mean crediting nobody exactly when it matters.
 *
 * sender-identity.test.ts pins the precedence in isolation. These cases exist
 * because the interesting failures are at the joins: which person the run reads,
 * what a departed one degrades to, and that the name is frozen onto the queued
 * row rather than read back later.
 */
describe("the display name a campaign run sends under", () => {
  const SUBJECT = "Hello";
  const BODY = "<p>Hi</p>";

  let seq = 0;
  /**
   * A scoped campaign whose sender is named, so "the person's name" is a value
   * a test can actually see rather than an empty string that would match null.
   */
  async function named(opts: { scopeFromEmail?: string | null; scopeFromName?: string } = {}) {
    // One chooser per call, all with the SAME name: two of these coexist in a
    // single case, and contactEmail is unique while name is not.
    seq += 1;
    const chooser = await prisma.person.create({
      data: { name: "Jack Carney", contactEmail: `jack${seq}@example.com`, status: "ACTIVE" },
    });
    const scope = await createScope(null, {
      name: `Peds ${seq}`,
      audience: ALL_ACTIVE,
      ...(opts.scopeFromEmail ? { fromEmail: opts.scopeFromEmail } : {}),
      ...(opts.scopeFromName ? { fromName: opts.scopeFromName } : {}),
    });
    await grantScope(null, scope.id, { personId: chooser.id });
    const campaign = await createDraft(chooser.id, "Newsletter", { scopeId: scope.id });
    return { chooser, scope, campaign };
  }

  /** Compose and pin, exactly as the compose form's save does. */
  async function compose(chooserId: string | null, campaignId: string, fromEmail?: string) {
    await updateCampaign(chooserId, campaignId, {
      subject: SUBJECT,
      body: BODY,
      audience: ALL_ACTIVE,
      ...(fromEmail === undefined ? {} : { fromEmail }),
    });
  }

  async function fromOf(runId: string) {
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: runId } });
    expect(logs.length).toBeGreaterThan(0);
    return {
      emails: [...new Set(logs.map((l) => l.fromEmail))],
      names: [...new Set(logs.map((l) => l.fromName))],
    };
  }

  it("prefers an identity's admin-set name over the name of the person who chose it", async () => {
    const { chooser, campaign } = await named({ scopeFromEmail: "peds@havenfreeclinic.org" });
    await issueSendingIdentity(null, {
      personId: chooser.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
    });
    await compose(chooser.id, campaign.id, "recruitment@havenfreeclinic.org");

    const res = await sendCampaignNow(chooser.id, campaign.id, {});
    const { emails, names } = await fromOf(res.runId);
    expect(emails).toEqual(["recruitment@havenfreeclinic.org"]);
    // The institutional voice an admin configured, not the human who sent it.
    expect(names).toEqual(["HAVEN Recruitment"]);
  });

  it("names the person who chose the identity when it carries no admin name", async () => {
    // Same fixture as above with ONE difference: the identity has no
    // displayName. If this and the case above ever agree, the precedence is not
    // being applied.
    const { chooser, campaign } = await named({ scopeFromEmail: "peds@havenfreeclinic.org" });
    await issueSendingIdentity(null, {
      personId: chooser.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await compose(chooser.id, campaign.id, "recruitment@havenfreeclinic.org");

    const res = await sendCampaignNow(chooser.id, campaign.id, {});
    const { emails, names } = await fromOf(res.runId);
    expect(emails).toEqual(["recruitment@havenfreeclinic.org"]);
    expect(names).toEqual(["Jack Carney"]);
  });

  it("applies the same precedence to a SCOPE identity's admin-set name", async () => {
    // A scope's fromName is an admin's choice on the delegation boundary
    // itself, so it outranks the sender for the same reason an issued
    // displayName does.
    const withName = await named({
      scopeFromEmail: "peds@havenfreeclinic.org",
      scopeFromName: "HAVEN Pediatrics",
    });
    // Pinned explicitly, so there IS a chooser to lose to. Picking nothing would
    // leave fromEmailSetById null and the case would pass with no precedence at
    // all.
    await compose(withName.chooser.id, withName.campaign.id, "peds@havenfreeclinic.org");
    const namedRun = await sendCampaignNow(withName.chooser.id, withName.campaign.id, {});
    expect((await fromOf(namedRun.runId)).names).toEqual(["HAVEN Pediatrics"]);

    // The same scope address with no fromName set: the chooser shows through.
    const withoutName = await named({ scopeFromEmail: "exec@havenfreeclinic.org" });
    await compose(withoutName.chooser.id, withoutName.campaign.id, "exec@havenfreeclinic.org");
    const bareRun = await sendCampaignNow(withoutName.chooser.id, withoutName.campaign.id, {});
    const bare = await fromOf(bareRun.runId);
    expect(bare.emails).toEqual(["exec@havenfreeclinic.org"]);
    expect(bare.names).toEqual(["Jack Carney"]);
  });

  it("credits the person who CHOSE the identity, not the actor dispatching the run", async () => {
    // The case the doc comment above senderForRun already warns about, now with
    // a name attached to it. A recurring campaign is dispatched by cron with no
    // actor, weeks after composition; a different colleague can also press Send
    // on a shared scope. Reading the dispatcher would put the wrong human on
    // every recurring send, and NOBODY on a cron one.
    const { chooser, scope, campaign } = await named({
      scopeFromEmail: "peds@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      personId: chooser.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await compose(chooser.id, campaign.id, "recruitment@havenfreeclinic.org");

    const colleague = await prisma.person.create({
      data: { name: "Dana Ops", contactEmail: "dana@example.com", status: "ACTIVE" },
    });
    await grantScope(null, scope.id, { personId: colleague.id });

    // Dispatched by the colleague. The From names the chooser.
    const byColleague = await sendCampaignNow(colleague.id, campaign.id, {});
    expect((await fromOf(byColleague.runId)).names).toEqual(["Jack Carney"]);

    // And dispatched with NO actor at all, which is the cron shape. Reading the
    // actor here would produce no name; reading the chooser produces theirs.
    const cronCampaign = await createDraft(chooser.id, "Recurring", { scopeId: scope.id });
    await compose(chooser.id, cronCampaign.id, "recruitment@havenfreeclinic.org");
    const byCron = await executeRun(cronCampaign.id, {
      actorId: null,
      claimWhere: { status: "DRAFT" },
      statusUpdate: { status: "SENT" },
    });
    expect((await fromOf(byCron.runId)).names).toEqual(["Jack Carney"]);
  });

  it("sends with no display name, and does not throw, when nobody chose the identity", async () => {
    // An unscoped-choice campaign: the sender picked nothing, so
    // fromEmailSetById is null and there is no person whose name this send would
    // be crediting. The address still resolves from the scope, and the run must
    // complete -- a missing name is cosmetic, a throw fails the run.
    const { chooser, campaign } = await named({ scopeFromEmail: "peds@havenfreeclinic.org" });
    await activePerson("Sam Rivera", "sam@example.com");
    await compose(chooser.id, campaign.id);
    expect(
      (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } }))
        .fromEmailSetById,
    ).toBeNull();

    const res = await sendCampaignNow(chooser.id, campaign.id, {});
    const { emails, names } = await fromOf(res.runId);
    expect(emails).toEqual(["peds@havenfreeclinic.org"]);
    expect(names).toEqual([null]);
  });

  it("sends with no display name, and does not throw, once the chooser is deleted", async () => {
    // fromEmailSetById is SetNull on delete, so a campaign can legitimately
    // outlive its chooser -- and a recurring one keeps running after they leave.
    // The address is pinned to the SCOPE identity so it survives the chooser
    // going away (the issued route would not), which isolates this case to the
    // name.
    const { chooser, campaign } = await named({ scopeFromEmail: "peds@havenfreeclinic.org" });
    await activePerson("Sam Rivera", "sam@example.com");
    await compose(chooser.id, campaign.id, "peds@havenfreeclinic.org");
    expect(
      (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } }))
        .fromEmailSetById,
    ).toBe(chooser.id);

    await prisma.person.delete({ where: { id: chooser.id } });

    // Dispatched with no actor, as cron would. Must not throw.
    const res = await executeRun(campaign.id, {
      actorId: null,
      claimWhere: { status: "DRAFT" },
      statusUpdate: { status: "SENT" },
    });
    const { emails, names } = await fromOf(res.runId);
    expect(emails).toEqual(["peds@havenfreeclinic.org"]);
    expect(names).toEqual([null]);
  });

  it("snapshots the name at enqueue, so a later rename does not rewrite queued mail", async () => {
    // The same principle the address already rests on. EmailLog is the record of
    // what was sent, and the drain re-reads the row verbatim minutes or hours
    // later, so a name resolved at delivery time would let a rename retroactively
    // change mail already accepted.
    const { chooser, scope, campaign } = await named({
      scopeFromEmail: "peds@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      personId: chooser.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await compose(chooser.id, campaign.id, "recruitment@havenfreeclinic.org");
    const first = await sendCampaignNow(chooser.id, campaign.id, {});
    expect((await fromOf(first.runId)).names).toEqual(["Jack Carney"]);

    await prisma.person.update({
      where: { id: chooser.id },
      data: { name: "J. R. Carney" },
    });

    // Already queued: unchanged.
    expect((await fromOf(first.runId)).names).toEqual(["Jack Carney"]);

    // And unchanged all the way to the wire. The row is what the drain reads,
    // minutes or hours later, so this is the assertion that separates "the name
    // was snapshotted" from "the name is resolved at delivery time" -- the
    // latter would put the new name on mail accepted under the old one, and
    // would look identical in every other case here.
    const delivered: Array<string | undefined> = [];
    await sendModule.drainEmailQueue({
      async send(msg) {
        delivered.push(msg.fromName);
      },
    });
    expect(delivered.length).toBeGreaterThan(0);
    expect([...new Set(delivered)]).toEqual(["Jack Carney"]);

    // The rename DID take, so the assertions above are about the snapshot rather
    // than about renames never reaching the From at all. A new run by the same
    // chooser carries the new name.
    const later = await createDraft(chooser.id, "Next", { scopeId: scope.id });
    await compose(chooser.id, later.id, "recruitment@havenfreeclinic.org");
    const second = await sendCampaignNow(chooser.id, later.id, {});
    expect((await fromOf(second.runId)).names).toEqual(["J. R. Carney"]);
  });

  it("gives the sender test and the campaign test send the same From as a real run", async () => {
    // sendSenderTest is the one check that confirms an address is usable, and it
    // is worth nothing as a preview if the message it sends carries a different
    // From than the run it stands in for. senderTestFrom is the seam that
    // resolves it; the campaign's own test send reaches the same answer through
    // senderForRun.
    const { chooser, campaign } = await named({ scopeFromEmail: "peds@havenfreeclinic.org" });
    const issued = await issueSendingIdentity(null, {
      personId: chooser.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await compose(chooser.id, campaign.id, "recruitment@havenfreeclinic.org");

    await testSend(chooser.id, campaign.id, "check@example.com");
    const preview = await prisma.emailLog.findFirstOrThrow({
      where: { template: "campaign:test" },
    });
    const senderTest = await senderTestFrom(issued.id, chooser.id);

    const res = await sendCampaignNow(chooser.id, campaign.id, {});
    const real = await prisma.emailLog.findFirstOrThrow({ where: { campaignRunId: res.runId } });

    expect({ fromEmail: real.fromEmail, fromName: real.fromName }).toEqual({
      fromEmail: "recruitment@havenfreeclinic.org",
      fromName: "Jack Carney",
    });
    expect({ fromEmail: preview.fromEmail, fromName: preview.fromName }).toEqual({
      fromEmail: real.fromEmail,
      fromName: real.fromName,
    });
    expect(senderTest).toEqual({ fromEmail: real.fromEmail, fromName: real.fromName });
  });
});
