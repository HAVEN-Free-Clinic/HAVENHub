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
import { log, errorAttrs } from "@/platform/logging";
import { effectiveComplianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import { getActiveTerm } from "@/platform/terms/active-term";
import { notify } from "@/platform/notifications/notify";
import { resolveChannel } from "@/platform/notifications/channel";
import { renderEmail } from "./templates/renderEmail";
import { complianceReminderContext, READABLE_STATUS } from "./templates/compliance";
import {
  onboardingReminderContext,
  clearanceDigestContext,
  type ClearanceDigestMember,
} from "./templates/clearance";
import { loadEhsMissingMap } from "@/platform/ehs/services/status";
import { loadClearanceMap } from "@/platform/clearance";
import { isoWeekKey } from "@/platform/dates";
import { claimReminderDispatch } from "./reminder-dispatch";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days a member is left alone before the onboarding reminder starts. Deliberately a
 * constant rather than a setting: one cadence knob is enough, and this is a fixed
 * "let them arrive first" courtesy, not an operational dial. Promote it to the
 * settings registry only if ops actually asks.
 */
const ONBOARDING_REMINDER_GRACE_DAYS = 2;

/**
 * Days stalled before the digest flags a member as overdue. 21 is where the retired
 * threshold escalation used to fire: three reminders at the 7-day HIPAA interval.
 * Keeping that boundary is what stops a six-week holdout reading the same as someone
 * who joined on Tuesday. A constant, not a setting, because the setting it derived
 * from was removed with the escalation.
 */
const DIGEST_STALLED_FLAG_DAYS = 21;

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
  digestsSent: number;
  reset: number;
  skipped: number;
  /** Members whose reminder threw. The run continues past them (audit 14). */
  failed: number;
};

/**
 * A member the run found uncleared, carried into the weekly director digest.
 * `stalledSince` is non-nullable here: by the time a member is recorded, the row has
 * either carried a stall marker forward or just been stamped with `now`.
 */
type UnclearedMember = {
  name: string;
  items: string[];
  stalledSince: Date;
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
    digestsSent: 0,
    reset: 0,
    skipped: 0,
    failed: 0,
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
    // A cached entraObjectId is NOT required to reach someone on Teams. notify()
    // resolves the id from Graph when it is missing and caches it, and falls back
    // to email when that fails -- so gating on the cached value here skipped every
    // member whose id had not been looked up yet, and (because the claim is taken
    // only inside the else branch) they were skipped again on every subsequent
    // run. A contactEmail is enough for notify to deliver on either channel; the
    // only genuinely unreachable member is one with neither (audit 14).
    if (wantsTeams && !!person.contactEmail) return true;
    return (wantsEmail && !!person.contactEmail) || (wantsTeams && !!person.entraObjectId);
  };

  // 5. Load the EHS missing map + full clearance for all candidates once per run.
  //    loadEhsMissingMap gives the specific outstanding EHS course names for the
  //    onboarding email; loadClearanceMap gives the per-term step config plus the
  //    missing task keys that drive the onboarding leg.
  const ehsMissingByPerson = await loadEhsMissingMap(termId);
  const clearanceByPerson = await loadClearanceMap(personIds, termId);

  // Members the loop finds uncleared, carried into the weekly digest after it.
  const uncleared = new Map<string, UnclearedMember>();

  // 5 + 6 + 7. Process each candidate.
  for (const person of persons) {
   // Per-person isolation, matching every sibling reminder job (shift-reminders,
   // checkin-invites and attending-reminders all do this). Without it a single
   // rejection from notify()/renderEmail -- a pool timeout under the
   // O(active members) write phase, a transient reset, a template miss -- escaped
   // the loop and took the whole run with it: everyone after this person was
   // skipped for the day, and sendClearanceDigests never ran, so the weekly
   // director digest was lost too. This is the most compliance-critical job in
   // the set and was the only one without the guard (audit 14).
   //
   // The claim is deliberately NOT rolled back. It is taken before the send, and
   // re-sending a HIPAA nag is worse than delaying one by an interval.
   try {
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

    // Record for the weekly digest. Unconditional on delivery: the digest is about
    // who is not cleared, and a member no channel could reach still belongs in it
    // (arguably belongs in it most).
    //
    // stalledSince is known without re-reading the row. Either the row already
    // carried one, or the upsert/updateMany a few lines above just stamped `now`.
    uncleared.set(person.id, {
      name: person.name,
      items: [
        ...(hipaaUnsatisfied ? [`HIPAA certification: ${READABLE_STATUS[hipaaStatus]}`] : []),
        ...items,
      ],
      stalledSince: existing?.stalledSince ?? now,
    });
   } catch (err) {
    log.error(
      "[reminders] person failed; continuing with the rest of the roster",
      errorAttrs(err, { personId: person.id }),
    );
    result.failed++;
   }
  }

  await sendClearanceDigests(termId, uncleared, now, baseUrl, result);

  // Surface the run size + duration so the write phase (O(active members) serial
  // round-trips) can be watched trending toward the 300s budget before it truncates.
  log.info("[reminders] run complete", {
    candidates: persons.length,
    elapsedMs: Date.now() - startedAt,
    ...result,
  });
  return result;
}

// ---------------------------------------------------------------------------
// sendClearanceDigests (private helper)
// ---------------------------------------------------------------------------

/**
 * Queue one weekly roll-up per director covering every uncleared member in the
 * departments where they hold an ACTIVE DIRECTOR membership this term.
 *
 * The weekly cadence comes from the claim, not from a schedule: the periodKey is the
 * ISO week, so the first daily run of each week wins and the other six skip. That
 * needs no day-of-week branch, and it self-heals when a run fails, unlike a hard
 * weekly cron which would silently skip the entire week.
 *
 * Directors are resolved from TermMembership kind DIRECTOR rather than from RBAC,
 * matching the escalation this replaced. A director in several departments gets one
 * email spanning all of them, and never appears in their own digest.
 */
async function sendClearanceDigests(
  termId: string,
  uncleared: Map<string, UnclearedMember>,
  now: Date,
  baseUrl: string,
  result: ReminderRunResult
): Promise<void> {
  if (uncleared.size === 0) return;

  const memberships = await prisma.termMembership.findMany({
    where: { termId, status: "ACTIVE" },
    select: {
      personId: true,
      kind: true,
      departmentId: true,
      department: { select: { code: true, name: true } },
      person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true } },
    },
    orderBy: { department: { code: "asc" } },
  });

  type DirectorPerson = { id: string; name: string; contactEmail: string | null; entraObjectId: string | null };

  const deptName = new Map<string, string>();
  const deptCode = new Map<string, string>();
  const directorById = new Map<string, DirectorPerson>();
  const deptsByDirector = new Map<string, Set<string>>();
  const rowsByDept = new Map<string, Array<{ personId: string } & ClearanceDigestMember>>();

  const flagCutoff = new Date(now.getTime() - DIGEST_STALLED_FLAG_DAYS * MS_PER_DAY);

  for (const m of memberships) {
    deptName.set(m.departmentId, m.department.name);
    deptCode.set(m.departmentId, m.department.code);

    if (m.kind === "DIRECTOR") {
      directorById.set(m.person.id, m.person);
      const set = deptsByDirector.get(m.person.id) ?? new Set<string>();
      set.add(m.departmentId);
      deptsByDirector.set(m.person.id, set);
    }

    const u = uncleared.get(m.personId);
    if (!u) continue;
    const list = rowsByDept.get(m.departmentId) ?? [];
    list.push({
      personId: m.personId,
      name: u.name,
      departmentName: m.department.name,
      items: u.items,
      stalledDays: Math.floor((now.getTime() - u.stalledSince.getTime()) / MS_PER_DAY),
      flagged: u.stalledSince < flagCutoff,
    });
    rowsByDept.set(m.departmentId, list);
  }

  const periodKey = isoWeekKey(now);

  for (const [directorId, deptIds] of deptsByDirector) {
    const director = directorById.get(directorId);
    if (!director) continue;
    if (!director.contactEmail && !director.entraObjectId) continue;

    // Dedupe members across the director's departments; first department by code wins,
    // matching how the retired escalation picked a department name.
    const ordered = [...deptIds].sort((a, b) =>
      (deptCode.get(a) ?? "").localeCompare(deptCode.get(b) ?? "")
    );
    const rows = new Map<string, ClearanceDigestMember>();
    for (const deptId of ordered) {
      for (const row of rowsByDept.get(deptId) ?? []) {
        if (row.personId === directorId) continue;
        if (!rows.has(row.personId)) rows.set(row.personId, row);
      }
    }
    if (rows.size === 0) continue;

    // Longest stalled first.
    const members = [...rows.values()].sort((a, b) => b.stalledDays - a.stalledDays);

    // Claim last, so nothing before this consumes the week's slot. A failed claim
    // means this director already got their digest for this ISO week.
    if (!(await claimReminderDispatch("clearance-digest", directorId, periodKey))) continue;

    const departmentNames = ordered
      .map((id) => deptName.get(id))
      .filter((n): n is string => Boolean(n))
      .join(", ");
    const reviewUrl = `${baseUrl}/volunteers`;

    const rendered = await renderEmail(
      "clearance-digest",
      clearanceDigestContext({
        directorName: director.name,
        departmentNames,
        members,
        reviewUrl,
      }),
    );
    await notify(prisma, {
      type: "clearance-digest",
      person: {
        id: director.id,
        entraObjectId: director.entraObjectId,
        contactEmail: director.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: "Weekly clearance digest",
        summary: `${members.length} member${members.length === 1 ? "" : "s"} in ${departmentNames} are not cleared.`,
        // /volunteers gates on volunteers.view, which the seeded Director baseline
        // holds, and it is the compliance surface itself. /admin gates on admin.access,
        // which Director does NOT hold, so linking there resolves to /no-access for
        // this notification's entire intended audience (#70).
        link: reviewUrl,
      },
    });
    result.digestsSent++;
  }
}
