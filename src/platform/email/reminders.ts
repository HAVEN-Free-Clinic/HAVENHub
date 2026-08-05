/**
 * Compliance reminder engine for HAVEN Hub.
 *
 * State machine summary
 * ---------------------
 * Each ComplianceReminder row tracks one person's non-compliant streak.
 *
 *   COMPLIANT -> row is reset to zeroed state (remindersSent=0, lastRemindedAt=null).
 *                Zeroed rows and absent rows are left alone.
 *
 *   Non-compliant (EXPIRING_SOON | EXPIRED | UNKNOWN_DATE | NO_CERTIFICATE):
 *     1. Dedup window check: if lastRemindedAt is within COMPLIANCE_REMINDER_INTERVAL_DAYS,
 *        the person is skipped entirely (no reminder, no escalation evaluation).
 *     2. If the notification channel cannot reach the person, they are skipped
 *        (state is not advanced): the "email"/"both" channel needs a contactEmail,
 *        the "teams"/"both" channel needs a Teams identity. Under the default
 *        "email" channel a Teams-only member is unreachable and is NOT claimed or
 *        escalated, since notify() would queue nothing for them.
 *     3. A reminder email is queued; remindersSent is incremented; lastRemindedAt = now.
 *
 * All notifications are dispatched via notify(); no transport is invoked here.
 */

import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { log } from "@/platform/logging";
import { effectiveComplianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import { getActiveTerm } from "@/platform/terms/active-term";
import { notify } from "@/platform/notifications/notify";
import { resolveChannel } from "@/platform/notifications/channel";
import { renderEmail } from "./templates/renderEmail";
import { complianceReminderContext } from "./templates/compliance";
import { loadClearanceMap } from "@/platform/clearance";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Counters returned by a single engine run. */
export type ReminderRunResult = {
  remindersSent: number;
  reset: number;
  skipped: number;
};

/**
 * Run one cycle of the compliance reminder engine.
 *
 * Resolves the active term, scans all active candidates, applies the dedup
 * and escalation state machine, and returns summary counters. Idempotent
 * within the dedup window: re-running with the same "now" is safe.
 *
 * @param now  Reference timestamp (defaults to the current wall clock). Pass
 *             an explicit value in tests for deterministic behavior.
 */
export async function runComplianceReminders(
  now: Date = new Date()
): Promise<ReminderRunResult> {
  const startedAt = Date.now();
  const result: ReminderRunResult = {
    remindersSent: 0,
    reset: 0,
    skipped: 0,
  };

  // 1. Resolve the active term. Bail out early when none exists.
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return result;

  const termId = activeTerm.id;

  // 2. Candidate people: ACTIVE persons with at least one ACTIVE TermMembership
  //    in the active term. Two-step: membership ids -> person rows (ACTIVE only).
  const membershipRows = await prisma.termMembership.findMany({
    where: { termId, status: "ACTIVE" },
    select: { personId: true },
  });

  const candidateIds = Array.from(
    new Set(membershipRows.map((m) => m.personId))
  );

  if (candidateIds.length === 0) return result;

  const persons = await prisma.person.findMany({
    where: { id: { in: candidateIds }, status: "ACTIVE" },
    select: { id: true, name: true, contactEmail: true, entraObjectId: true },
  });

  if (persons.length === 0) return result;

  const personIds = persons.map((p) => p.id);

  // 3. Full cert history per candidate, newest-first. Order by (personId asc,
  //    uploadedAt desc) then group per personId, preserving newest-first order so
  //    effectiveComplianceStatus can fall back to an older still-valid verified cert
  //    when the newest is an early renewal awaiting verification.
  const allCerts = await prisma.hipaaCertificate.findMany({
    where: { personId: { in: personIds } },
    orderBy: [{ personId: "asc" }, { uploadedAt: "desc" }],
    select: { personId: true, completionDate: true, verifiedAt: true },
  });

  const certsByPerson = new Map<string, Array<{ completionDate: Date | null; verifiedAt: Date | null }>>();
  for (const c of allCerts) {
    const list = certsByPerson.get(c.personId);
    const entry = { completionDate: c.completionDate, verifiedAt: c.verifiedAt };
    if (list) list.push(entry);
    else certsByPerson.set(c.personId, [entry]);
  }

  // 4. Existing reminder rows.
  const existingRows = await prisma.memberReminderState.findMany({
    where: { personId: { in: personIds } },
  });
  const reminderMap = new Map(existingRows.map((r) => [r.personId, r]));

  // Pre-compute the interval in milliseconds.
  const intervalMs =
    (await getSetting<number>("compliance.reminderIntervalDays")) * 24 * 60 * 60 * 1000;

  // Resolved once for the run: the hub base URL (for the My Info call-to-action
  // and Teams deep link) and the brand color (for the CTA button).
  const baseUrl = await getSetting<string>("app.baseUrl");
  const brandColor = await getSetting<string>("branding.brandColor");

  // The channel that will actually carry the reminder (constant per run). The
  // reachability guard below is relative to it: a reminder only lands when the
  // channel matches an identifier the member has -- email needs contactEmail,
  // Teams needs entraObjectId. Under the shipped default ("email"), a Teams-only
  // member is unreachable and must be skipped, not claimed and escalated.
  const reminderChannel = await resolveChannel("compliance-reminder");
  const reminderWantsEmail = reminderChannel === "email" || reminderChannel === "both";
  const reminderWantsTeams = reminderChannel === "teams" || reminderChannel === "both";

  // 5. Load full clearance for all candidates once per run. Only the per-term step
  //    config is read from it here (to tell "HIPAA disabled this term" apart from
  //    "HIPAA satisfied"); the HIPAA status itself comes from `status` below so the
  //    expiring-soon nudge is preserved.
  const clearanceByPerson = await loadClearanceMap(personIds, termId);

  // 5 + 6 + 7. Process each candidate.
  for (const person of persons) {
    const certs = certsByPerson.get(person.id) ?? [];
    const cert = certs[0] ?? null;
    // Effective (all-certs) status: an early renewal awaiting verification must not
    // flip a still-cleared member back to PENDING_VERIFICATION and re-trigger reminders
    // + director escalation. EXPIRING_SOON is still surfaced so the renewal nudge holds.
    const status = effectiveComplianceStatus(certs, activeTerm.endDate, now);
    const existing = reminderMap.get(person.id) ?? null;
    const clearance = clearanceByPerson.get(person.id);
    // A term can disable the HIPAA/EHS onboarding step. loadClearanceMap drops a
    // disabled step from `tasks`, so its absence means "not required this term":
    // such an item must not block clearance, nag, or escalate. Neutralize a
    // disabled leg for both the done-gate and the reminder body.
    const hipaaEnabled = clearance?.tasks.some((t) => t.key === "hipaa") ?? true;
    const effectiveStatus = hipaaEnabled ? status : "COMPLIANT";
    // This stream is now purely about the HIPAA certificate, so the gate is the HIPAA
    // status alone: unsatisfied for every status except COMPLIANT, which keeps the
    // EXPIRING_SOON renewal nudge flowing. EHS and the remaining onboarding items are
    // no longer carried here; the onboarding-reminder stream picks them up.
    const isDone = effectiveStatus === "COMPLIANT";

    // --- HIPAA satisfied: reset any lingering reminder state ---
    if (isDone) {
      if (
        existing !== null &&
        (existing.remindersSent > 0 || existing.lastRemindedAt !== null)
      ) {
        await prisma.memberReminderState.update({
          where: { personId: person.id },
          data: {
            remindersSent: 0,
            lastRemindedAt: null,
          },
        });
        result.reset++;
      }
      continue;
    }

    // --- Not cleared: remind (and escalate at threshold) ---

    // a. No channel can actually reach the member: skip without advancing state.
    //    A reminder only lands when the resolved channel matches an identifier the
    //    member has. The old guard skipped only when BOTH were absent, on the
    //    assumption that a Teams-reachable member is reminded via Teams -- but with
    //    the default channel "email", notify() queues nothing for a member with no
    //    contactEmail, while the row was still claimed, counted, and (at threshold)
    //    escalated to their directors, so a member never contacted on any channel
    //    looked "reminded". Gate on the channel that will actually carry the send.
    //    This check runs BEFORE the claim so an unreachable person never gets a row.
    const reachableByEmail = reminderWantsEmail && !!person.contactEmail;
    const reachableByTeams = reminderWantsTeams && !!person.entraObjectId;
    if (!reachableByEmail && !reachableByTeams) {
      log.info(
        `[reminders] Skipping person ${person.id} (${person.name}): channel ${reminderChannel} cannot reach them (contactEmail=${person.contactEmail ? "yes" : "no"}, teams=${person.entraObjectId ? "yes" : "no"}).`,
        { personId: person.id },
      );
      result.skipped++;
      continue;
    }

    // b. Atomic dedup claim. Ensure a row exists, then claim it for THIS tick only
    //    when it is outside the reminder interval, incrementing remindersSent in the
    //    same statement. updateMany is atomic, so two overlapping cron runs cannot
    //    both win the claim, which prevents duplicate reminders and duplicate
    //    escalations. count === 0 means we are inside the dedup window (previously an
    //    early `continue`) or a concurrent run already claimed this tick. Claiming
    //    before the send trades a possible lost reminder on a mid-run crash
    //    (recovered next interval) for guaranteed no-duplicate delivery.
    const cutoff = new Date(now.getTime() - intervalMs);
    await prisma.memberReminderState.upsert({
      where: { personId: person.id },
      create: { personId: person.id, remindersSent: 0 },
      update: {},
    });
    const claim = await prisma.memberReminderState.updateMany({
      where: {
        personId: person.id,
        OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: cutoff } }],
      },
      data: { lastRemindedAt: now, remindersSent: { increment: 1 } },
    });
    if (claim.count === 0) {
      result.skipped++;
      continue;
    }

    // c. Send reminder.
    const expiresAt =
      cert?.completionDate ? certExpiresAt(cert.completionDate) : null;

    const renderedReminder = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: person.name,
        status: effectiveStatus,
        expiresAt,
        appUrl: baseUrl,
        brandColor,
      }),
    );
    await notify(prisma, {
      type: "compliance-reminder",
      person: {
        id: person.id,
        entraObjectId: person.entraObjectId,
        contactEmail: person.contactEmail,
      },
      email: { subject: renderedReminder.subject, html: renderedReminder.html },
      teams: {
        title: "Compliance reminder",
        summary: "You have outstanding compliance requirements. Please review your compliance status.",
        link: `${baseUrl}/get-started`,
      },
    });

    result.remindersSent++;
  }

  // Surface the run size + duration so the write phase (O(active members) serial
  // round-trips) can be watched trending toward the 300s budget before it truncates.
  log.info("[reminders] run complete", {
    candidates: persons.length,
    elapsedMs: Date.now() - startedAt,
    ...result,
  });
  return result;
}
