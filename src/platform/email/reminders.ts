/**
 * Compliance reminder engine for HAVEN Hub.
 *
 * State machine summary
 * ---------------------
 * Each ComplianceReminder row tracks one person's non-compliant streak.
 *
 *   COMPLIANT -> row is reset to zeroed state (remindersSent=0, escalatedAt=null).
 *                Zeroed rows and absent rows are left alone.
 *
 *   Non-compliant (EXPIRING_SOON | EXPIRED | UNKNOWN_DATE | NO_CERTIFICATE):
 *     1. Dedup window check: if lastRemindedAt is within COMPLIANCE_REMINDER_INTERVAL_DAYS,
 *        the person is skipped entirely (no reminder, no escalation evaluation).
 *     2. If no contactEmail, the person is skipped (state is not advanced).
 *     3. A reminder email is queued; remindersSent is incremented; lastRemindedAt = now.
 *     4. Escalation fires once per non-compliant streak, guarded by escalatedAt:
 *        when the NEW remindersSent >= COMPLIANCE_ESCALATION_THRESHOLD AND escalatedAt
 *        is currently null, escalation emails are queued to each director of any
 *        department where the volunteer holds an ACTIVE membership in the active term.
 *        Directors are deduped by personId and the volunteer themselves is excluded.
 *        Escalation emails are queued BEFORE escalatedAt is persisted so that a crash
 *        between the two re-queues on the next run (at-least-once) rather than leaving
 *        escalatedAt set with no director notification ever sent.
 *
 * All notifications are dispatched via notify(); no transport is invoked here.
 */

import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { complianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import { getActiveTerm } from "@/platform/terms/active-term";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "./templates/renderEmail";
import {
  complianceReminderContext,
  complianceEscalationContext,
} from "./templates/compliance";
import { loadEhsMissingMap } from "@/platform/ehs/services/status";
import { isFullyCompliant } from "@/platform/ehs/engine/applicability";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Counters returned by a single engine run. */
export type ReminderRunResult = {
  remindersSent: number;
  escalationsSent: number;
  reset: number;
  skipped: number;
};

// ---------------------------------------------------------------------------
// runComplianceReminders
// ---------------------------------------------------------------------------

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
  const result: ReminderRunResult = {
    remindersSent: 0,
    escalationsSent: 0,
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

  // 3. Newest cert per candidate. Order by (personId asc, uploadedAt desc) then
  //    reduce to the first-seen entry per personId in JS.
  const allCerts = await prisma.hipaaCertificate.findMany({
    where: { personId: { in: personIds } },
    orderBy: [{ personId: "asc" }, { uploadedAt: "desc" }],
    select: { personId: true, completionDate: true, verifiedAt: true },
  });

  const certMap = new Map<string, { completionDate: Date | null; verifiedAt: Date | null }>();
  for (const c of allCerts) {
    if (!certMap.has(c.personId)) {
      certMap.set(c.personId, { completionDate: c.completionDate, verifiedAt: c.verifiedAt });
    }
  }

  // 4. Existing reminder rows.
  const existingRows = await prisma.complianceReminder.findMany({
    where: { personId: { in: personIds } },
  });
  const reminderMap = new Map(existingRows.map((r) => [r.personId, r]));

  // Pre-compute the interval in milliseconds.
  const intervalMs =
    (await getSetting<number>("compliance.reminderIntervalDays")) * 24 * 60 * 60 * 1000;
  const threshold = await getSetting<number>("compliance.escalationThreshold");

  // Resolved once for the run: the hub base URL (for the My Info call-to-action
  // and Teams deep link) and the brand color (for the CTA button).
  const baseUrl = await getSetting<string>("app.baseUrl");
  const brandColor = await getSetting<string>("branding.brandColor");

  // 5. Load the EHS missing map for all active-term members once per run.
  const ehsMissingByPerson = await loadEhsMissingMap(termId);

  // 5 + 6 + 7. Process each candidate.
  for (const person of persons) {
    const cert = certMap.get(person.id) ?? null;
    const status = complianceStatus(cert, activeTerm.endDate, now);
    const existing = reminderMap.get(person.id) ?? null;
    const ehsMissing = ehsMissingByPerson.get(person.id) ?? [];
    const isCompliant = isFullyCompliant({ hipaaStatus: status, ehsMissingCount: ehsMissing.length });

    // --- COMPLIANT ---
    if (isCompliant) {
      if (
        existing !== null &&
        (existing.remindersSent > 0 ||
          existing.escalatedAt !== null ||
          existing.lastRemindedAt !== null)
      ) {
        await prisma.complianceReminder.update({
          where: { personId: person.id },
          data: {
            remindersSent: 0,
            lastRemindedAt: null,
            lastStatus: null,
            escalatedAt: null,
          },
        });
        result.reset++;
      }
      continue;
    }

    // --- Non-compliant ---

    // a. Dedup window: skip entirely if within the interval.
    if (existing?.lastRemindedAt !== null && existing?.lastRemindedAt !== undefined) {
      const elapsed = now.getTime() - existing.lastRemindedAt.getTime();
      if (elapsed < intervalMs) {
        result.skipped++;
        continue;
      }
    }

    // b. No contact email: log a notice and skip (do not advance state).
    if (!person.contactEmail) {
      console.log(
        `[reminders] Skipping person ${person.id} (${person.name}): no contactEmail.`
      );
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
        status,
        expiresAt,
        appUrl: baseUrl,
        brandColor,
        ehsMissing,
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

    const newRemindersSent = (existing?.remindersSent ?? 0) + 1;

    // Determine whether escalation fires in this step.
    const shouldEscalate =
      newRemindersSent >= threshold && (existing?.escalatedAt ?? null) === null;

    // d. Queue escalation emails BEFORE writing escalatedAt. This way a crash
    //    between the queue call and the upsert re-queues on the next run
    //    (at-least-once) rather than leaving escalatedAt set with no emails sent.
    if (shouldEscalate) {
      await sendEscalations(person, termId, status, ehsMissing, result);
    }

    // Upsert the ComplianceReminder row. escalatedAt is set here, after
    // escalation emails have already been queued above.
    await prisma.complianceReminder.upsert({
      where: { personId: person.id },
      create: {
        personId: person.id,
        remindersSent: newRemindersSent,
        lastRemindedAt: now,
        lastStatus: status,
        escalatedAt: shouldEscalate ? now : null,
      },
      update: {
        remindersSent: newRemindersSent,
        lastRemindedAt: now,
        lastStatus: status,
        escalatedAt: shouldEscalate ? now : existing?.escalatedAt ?? null,
      },
    });

    result.remindersSent++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// sendEscalations (private helper)
// ---------------------------------------------------------------------------

/**
 * Resolve the directors for the volunteer's active-term departments and queue
 * one escalation email per unique director (with a contactEmail). The volunteer
 * themselves are excluded. The department name for the email is the first
 * department by code where both the volunteer and the director share a membership.
 *
 * Escalation emails are queued before escalatedAt is recorded in the caller's
 * upsert. A crash between the two re-queues on the next run (at-least-once)
 * rather than dropping the director notification silently.
 */
async function sendEscalations(
  volunteer: { id: string; name: string },
  termId: string,
  status: import("@/platform/compliance/rules").ComplianceStatus,
  ehsMissing: string[],
  result: ReminderRunResult
): Promise<void> {
  // Load the volunteer's active-term ACTIVE memberships with department info.
  const volunteerMemberships = await prisma.termMembership.findMany({
    where: {
      personId: volunteer.id,
      termId,
      status: "ACTIVE",
    },
    select: {
      departmentId: true,
      department: { select: { code: true, name: true } },
    },
    orderBy: { department: { code: "asc" } },
  });

  if (volunteerMemberships.length === 0) return;

  const volunteerDeptIds = volunteerMemberships.map((m) => m.departmentId);

  // Build a map from departmentId to { code, name } for the department name lookup.
  const deptMeta = new Map<string, { code: string; name: string }>();
  for (const m of volunteerMemberships) {
    deptMeta.set(m.departmentId, m.department);
  }

  // Load DIRECTOR memberships in the active term for those departments, with director person info.
  const directorMemberships = await prisma.termMembership.findMany({
    where: {
      termId,
      departmentId: { in: volunteerDeptIds },
      kind: "DIRECTOR",
      status: "ACTIVE",
    },
    select: {
      departmentId: true,
      person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true } },
    },
    orderBy: { department: { code: "asc" } },
  });

  // Dedupe directors by personId. Track the first department (by code order) for each.
  const seenDirectors = new Map<
    string,
    { id: string; name: string; contactEmail: string | null; entraObjectId: string | null; departmentName: string }
  >();

  for (const dm of directorMemberships) {
    const dirPersonId = dm.person.id;

    // Exclude the volunteer themselves.
    if (dirPersonId === volunteer.id) continue;

    if (!seenDirectors.has(dirPersonId)) {
      const dept = deptMeta.get(dm.departmentId);
      seenDirectors.set(dirPersonId, {
        id: dirPersonId,
        name: dm.person.name,
        contactEmail: dm.person.contactEmail,
        entraObjectId: dm.person.entraObjectId,
        // Use the first department by code (memberships are ordered by code asc).
        departmentName: dept?.name ?? "Unknown Department",
      });
    }
  }

  // Queue one escalation notification per director that has a contactEmail or entraObjectId.
  for (const [, director] of seenDirectors) {
    if (!director.contactEmail && !director.entraObjectId) continue;

    const renderedEscalation = await renderEmail(
      "compliance-escalation",
      complianceEscalationContext({
        directorName: director.name,
        volunteerName: volunteer.name,
        departmentName: director.departmentName,
        status,
        ehsMissing,
      }),
    );
    await notify(prisma, {
      type: "compliance-escalation",
      person: {
        id: director.id,
        entraObjectId: director.entraObjectId,
        contactEmail: director.contactEmail,
      },
      email: { subject: renderedEscalation.subject, html: renderedEscalation.html },
      teams: {
        title: "Compliance escalation",
        summary: `${volunteer.name} in ${director.departmentName} has outstanding compliance requirements.`,
        link: `${await getSetting<string>("app.baseUrl")}/admin`,
      },
    });

    result.escalationsSent++;
  }
}
