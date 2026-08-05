/**
 * Clearance reminder engine for HAVEN Hub.
 *
 * One pass over the active term's members produces two independent member-facing
 * streams, each with its own cadence and its own atomic claim:
 *
 *   HIPAA leg (compliance-reminder, `compliance.reminderIntervalDays`, 7 by default)
 *     Driven by effectiveComplianceStatus. Unsatisfied for every status except
 *     COMPLIANT, so EXPIRING_SOON keeps producing the renewal nudge.
 *
 *     This leg MUST read `status` and not ClearanceSummary.missing:
 *     deriveHipaaTaskState maps EXPIRING_SOON to COMPLETE, so `hipaa` is absent from
 *     `missing` for a member whose certificate expires next week. Deriving this leg
 *     from `missing` silently deletes the renewal nudge.
 *
 *   Onboarding leg (onboarding-reminder, `onboarding.reminderIntervalDays`, 1 by
 *   default) Driven by ClearanceSummary.missing with `hipaa` filtered out, so it
 *     covers profile, EHS, volunteer/director training, and learning. Suppressed for
 *     the first ONBOARDING_REMINDER_GRACE_DAYS of a member's earliest active
 *     membership, so a member who accepted yesterday meets the hub through their
 *     onboarding link rather than a list of things they have not done.
 *
 * Per-term step config is honored on both legs. A disabled step is dropped from
 * `tasks` (and therefore from `missing`) by loadClearanceMap, which covers the
 * onboarding leg for free; the HIPAA leg checks for the `hipaa` task explicitly
 * because it reads `status` rather than `missing`.
 *
 * `stalledSince` is stamped on the first nag of a streak and cleared when both legs
 * are satisfied. Unlike the per-leg claims it is stamped before the reachability
 * guards, because it is a statement about the member's state rather than about
 * delivery, and the weekly director digest specifically wants to surface members no
 * channel can reach.
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
import { onboardingReminderContext } from "./templates/clearance";
import { loadEhsMissingMap } from "@/platform/ehs/services/status";
import { loadClearanceMap } from "@/platform/clearance";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days a member is left alone before the onboarding reminder starts. Deliberately a
 * constant rather than a setting: one cadence knob is enough, and this is a fixed
 * "let them arrive first" courtesy, not an operational dial. Promote it to the
 * settings registry only if ops actually asks.
 */
const ONBOARDING_REMINDER_GRACE_DAYS = 2;

/**
 * Human-readable, self-serviceable outstanding items, keyed by onboarding task key.
 * `hipaa` is deliberately absent: it has its own stream.
 */
const REMINDER_ITEM_LABELS: Record<string, string> = {
  profile: "Confirm your contact details in your profile",
  ehs: "Complete your required EHS training",
  training: "Finish this term's volunteer training",
  directorTraining: "Finish this term's director training",
  learning: "Complete your assigned learning courses",
};

/**
 * Turn a member's missing task keys into display sentences for the onboarding email.
 * `hipaa` is dropped (its own stream covers it) and the EHS row is expanded with the
 * specific outstanding course names, which is the detail the bundled email used to
 * carry.
 */
function onboardingItems(missing: readonly string[], ehsMissing: string[]): string[] {
  const out: string[] = [];
  for (const key of missing) {
    if (key === "hipaa") continue;
    const label = REMINDER_ITEM_LABELS[key];
    if (!label) continue;
    out.push(key === "ehs" && ehsMissing.length > 0 ? `${label}: ${ehsMissing.join(", ")}` : label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Counters returned by a single engine run. */
export type ReminderRunResult = {
  hipaaRemindersSent: number;
  onboardingRemindersSent: number;
  reset: number;
  skipped: number;
};

/**
 * Run one cycle of the clearance reminder engine.
 *
 * Resolves the active term, scans all active candidates, applies each leg's dedup
 * claim, and returns summary counters. Idempotent within the dedup windows:
 * re-running with the same "now" is safe.
 *
 * @param now  Reference timestamp (defaults to the current wall clock). Pass
 *             an explicit value in tests for deterministic behavior.
 */
export async function runClearanceReminders(
  now: Date = new Date()
): Promise<ReminderRunResult> {
  const startedAt = Date.now();
  const result: ReminderRunResult = {
    hipaaRemindersSent: 0,
    onboardingRemindersSent: 0,
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
    select: { personId: true, createdAt: true },
  });

  const candidateIds = Array.from(
    new Set(membershipRows.map((m) => m.personId))
  );

  // Earliest active membership per person, for the onboarding grace period.
  const joinedAt = new Map<string, Date>();
  for (const m of membershipRows) {
    const seen = joinedAt.get(m.personId);
    if (!seen || m.createdAt < seen) joinedAt.set(m.personId, m.createdAt);
  }

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

  // Pre-compute each leg's interval in milliseconds.
  const hipaaIntervalMs =
    (await getSetting<number>("compliance.reminderIntervalDays")) * MS_PER_DAY;
  const onboardingIntervalMs =
    (await getSetting<number>("onboarding.reminderIntervalDays")) * MS_PER_DAY;

  // Resolved once for the run: the hub base URL (for the My Info call-to-action
  // and Teams deep link) and the brand color (for the CTA button).
  const baseUrl = await getSetting<string>("app.baseUrl");
  const brandColor = await getSetting<string>("branding.brandColor");

  // Each stream resolves its own channel: an admin can route one to Teams and leave
  // the other on email. The reachability guard below is relative to whichever channel
  // will actually carry that stream's send -- email needs contactEmail, Teams needs
  // entraObjectId. Under the shipped default ("email"), a Teams-only member is
  // unreachable and must be skipped, not claimed and counted as reminded.
  const hipaaChannel = await resolveChannel("compliance-reminder");
  const onboardingChannel = await resolveChannel("onboarding-reminder");

  const canReach = (
    channel: string,
    person: { contactEmail: string | null; entraObjectId: string | null }
  ): boolean => {
    const wantsEmail = channel === "email" || channel === "both";
    const wantsTeams = channel === "teams" || channel === "both";
    return (wantsEmail && !!person.contactEmail) || (wantsTeams && !!person.entraObjectId);
  };

  // 5. Load the EHS missing map + full clearance for all candidates once per run.
  //    loadEhsMissingMap gives the specific outstanding EHS course names for the
  //    onboarding email; loadClearanceMap gives the per-term step config plus the
  //    missing task keys that drive the onboarding leg.
  const ehsMissingByPerson = await loadEhsMissingMap(termId);
  const clearanceByPerson = await loadClearanceMap(personIds, termId);

  // 5 + 6 + 7. Process each candidate.
  for (const person of persons) {
    const certs = certsByPerson.get(person.id) ?? [];
    const cert = certs[0] ?? null;
    // Effective (all-certs) status: an early renewal awaiting verification must not
    // flip a still-cleared member back to PENDING_VERIFICATION and re-trigger nags.
    // EXPIRING_SOON is still surfaced so the renewal nudge holds.
    const status = effectiveComplianceStatus(certs, activeTerm.endDate, now);
    const clearance = clearanceByPerson.get(person.id);

    // A term can disable the HIPAA step. loadClearanceMap drops a disabled step from
    // `tasks`, so its absence means "not required this term": neutralize the leg.
    // The onboarding leg needs no equivalent, since a disabled step is already gone
    // from `missing`.
    const hipaaEnabled = clearance?.tasks.some((t) => t.key === "hipaa") ?? true;
    const hipaaStatus = hipaaEnabled ? status : "COMPLIANT";
    const hipaaUnsatisfied = hipaaStatus !== "COMPLIANT";

    const items = onboardingItems(
      clearance?.missing ?? [],
      ehsMissingByPerson.get(person.id) ?? []
    );
    const onboardingUnsatisfied = items.length > 0;

    const existing = reminderMap.get(person.id) ?? null;

    // --- Both legs satisfied: reset any lingering state ---
    if (!hipaaUnsatisfied && !onboardingUnsatisfied) {
      if (
        existing !== null &&
        (existing.remindersSent > 0 ||
          existing.onboardingRemindersSent > 0 ||
          existing.lastRemindedAt !== null ||
          existing.onboardingLastRemindedAt !== null ||
          existing.stalledSince !== null)
      ) {
        await prisma.memberReminderState.update({
          where: { personId: person.id },
          data: {
            remindersSent: 0,
            lastRemindedAt: null,
            onboardingRemindersSent: 0,
            onboardingLastRemindedAt: null,
            stalledSince: null,
          },
        });
        result.reset++;
      }
      continue;
    }

    // --- At least one leg outstanding ---

    // Ensure the row exists and stamp stalledSince if this is the start of a streak.
    // This runs before the reachability guards on purpose: an unreachable member is
    // exactly who a director needs to see in the weekly digest, and stalledSince is a
    // fact about the member's state, not about whether a send landed.
    await prisma.memberReminderState.upsert({
      where: { personId: person.id },
      create: { personId: person.id, stalledSince: now },
      update: {},
    });
    await prisma.memberReminderState.updateMany({
      where: { personId: person.id, stalledSince: null },
      data: { stalledSince: now },
    });

    // --- HIPAA leg ---
    if (hipaaUnsatisfied) {
      if (!canReach(hipaaChannel, person)) {
        log.info(
          `[reminders] Skipping HIPAA reminder for ${person.id} (${person.name}): channel ${hipaaChannel} cannot reach them.`,
          { personId: person.id },
        );
        result.skipped++;
      } else {
        // Atomic claim: updateMany cannot be won twice, so two overlapping cron runs
        // cannot both send. Claiming before the send trades a possible lost reminder
        // on a mid-run crash (recovered next interval) for guaranteed no duplicates.
        const claim = await prisma.memberReminderState.updateMany({
          where: {
            personId: person.id,
            OR: [
              { lastRemindedAt: null },
              { lastRemindedAt: { lt: new Date(now.getTime() - hipaaIntervalMs) } },
            ],
          },
          data: { lastRemindedAt: now, remindersSent: { increment: 1 } },
        });
        if (claim.count === 0) {
          result.skipped++;
        } else {
          const expiresAt = cert?.completionDate ? certExpiresAt(cert.completionDate) : null;
          const rendered = await renderEmail(
            "compliance-reminder",
            complianceReminderContext({
              personName: person.name,
              status: hipaaStatus,
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
            email: { subject: rendered.subject, html: rendered.html },
            teams: {
              title: "HIPAA certification reminder",
              summary: "Your HIPAA certification needs attention. Please review it in HAVEN Hub.",
              link: `${baseUrl}/my-info`,
            },
          });
          result.hipaaRemindersSent++;
        }
      }
    }

    // --- Onboarding leg ---
    if (onboardingUnsatisfied) {
      const joined = joinedAt.get(person.id);
      const inGrace =
        joined !== undefined &&
        now.getTime() - joined.getTime() < ONBOARDING_REMINDER_GRACE_DAYS * MS_PER_DAY;

      if (inGrace) {
        result.skipped++;
      } else if (!canReach(onboardingChannel, person)) {
        log.info(
          `[reminders] Skipping onboarding reminder for ${person.id} (${person.name}): channel ${onboardingChannel} cannot reach them.`,
          { personId: person.id },
        );
        result.skipped++;
      } else {
        const claim = await prisma.memberReminderState.updateMany({
          where: {
            personId: person.id,
            OR: [
              { onboardingLastRemindedAt: null },
              { onboardingLastRemindedAt: { lt: new Date(now.getTime() - onboardingIntervalMs) } },
            ],
          },
          data: {
            onboardingLastRemindedAt: now,
            onboardingRemindersSent: { increment: 1 },
          },
        });
        if (claim.count === 0) {
          result.skipped++;
        } else {
          const rendered = await renderEmail(
            "onboarding-reminder",
            onboardingReminderContext({
              personName: person.name,
              items,
              appUrl: baseUrl,
              brandColor,
            }),
          );
          await notify(prisma, {
            type: "onboarding-reminder",
            person: {
              id: person.id,
              entraObjectId: person.entraObjectId,
              contactEmail: person.contactEmail,
            },
            email: { subject: rendered.subject, html: rendered.html },
            teams: {
              title: "Outstanding onboarding requirements",
              summary: `You have ${items.length} item${items.length === 1 ? "" : "s"} left before you are cleared to volunteer.`,
              link: `${baseUrl}/get-started`,
            },
          });
          result.onboardingRemindersSent++;
        }
      }
    }
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
