import { prisma } from "@/platform/db";

/**
 * Cron liveness heartbeat.
 *
 * Every scheduled job is fired by an EXTERNAL scheduler (cron-job.org); vercel.json
 * declares no `crons`. If that schedule is dropped on re-provision, the account
 * lapses, or CRON_SECRET is rotated out-of-band, a job just stops -- and because the
 * enqueue-only jobs (reminders, shift-reminders, digest) leave no backlog and no
 * failed rows when dead, the failure is otherwise INVISIBLE until a human notices a
 * reminder never went out (a HIPAA-adjacent gap for a clinic).
 *
 * Each route stamps a heartbeat on success; the admin overview flags any job whose
 * last success is older than ~2x its cadence. Stored in the Setting key/value table
 * so this needs no schema change. Pair with a free external dead-man's-switch
 * (healthchecks.io / cronitor) for a push alert -- see docs/DEPLOY.md.
 */

const KEY_PREFIX = "cron.lastSuccess.";
// When getCronHealth first observes a job, it stamps a firstSeenAt marker so a job
// that has NEVER succeeded still has a start-of-watch anchor to age against. This
// lets us flag a never-provisioned job (or one with a wrong URL/secret, so every
// call 401s and no heartbeat is ever written) once it has been silent for longer
// than its own staleness window -- without false-alarming in the grace period right
// after a fresh deploy (#127). Setting-backed, so no schema change.
const FIRST_SEEN_PREFIX = "cron.firstSeen.";

/** The externally-scheduled jobs, with how stale a successful run may get before the
 *  dashboard flags it (~2x the job's cadence). Ids match the recordCronHeartbeat
 *  calls in each route. */
export const CRON_JOBS: { id: string; label: string; maxStaleMs: number }[] = [
  { id: "email", label: "Email delivery + campaign dispatch", maxStaleMs: 90 * 60 * 1000 }, // ~30m cadence
  { id: "reminders", label: "Compliance reminders + escalations", maxStaleMs: 50 * 60 * 60 * 1000 }, // daily
  { id: "recruitment-drafts", label: "Abandoned draft sweep", maxStaleMs: 50 * 60 * 60 * 1000 }, // daily
  { id: "recruitment-review-digest", label: "Recruitment review digest", maxStaleMs: 50 * 60 * 60 * 1000 }, // daily
  { id: "schedule-reminders", label: "Schedule reminders", maxStaleMs: 50 * 60 * 60 * 1000 }, // daily
  { id: "shift-reminders", label: "Weekly shift reminders", maxStaleMs: 9 * 24 * 60 * 60 * 1000 }, // weekly
  { id: "clinic-checkin-invites", label: "Clinic check-in invites", maxStaleMs: 50 * 60 * 60 * 1000 }, // daily
  { id: "wallet-passes", label: "Wallet badge reconciliation", maxStaleMs: 50 * 60 * 60 * 1000 }, // daily
];

/** Record a successful cron run. Never throws -- a heartbeat failure must not fail
 *  the actual job it is observing. */
export async function recordCronHeartbeat(jobId: string): Promise<void> {
  const key = `${KEY_PREFIX}${jobId}`;
  const value = { at: new Date().toISOString() };
  try {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  } catch {
    // Best-effort observability; swallow so the job's own result is unaffected.
  }
}

export type CronHealth = { id: string; label: string; lastSuccessAt: Date | null; stale: boolean; neverRun: boolean };

/**
 * Health of every tracked cron job. `stale` flags a job that is not running as
 * expected, covering BOTH failure modes:
 *   - it succeeded before but its last success is older than its threshold (a
 *     schedule that was firing and then stopped), and
 *   - it has NEVER succeeded and has been silent longer than its threshold since we
 *     first started watching it -- a job that was never provisioned on the external
 *     scheduler, or is provisioned with a wrong URL/secret so every request 401s
 *     (#127). `neverRun` distinguishes this case for the caller.
 *
 * The firstSeenAt anchor gives a grace period equal to the job's own staleness
 * window right after a fresh deploy, so a brand-new deployment does not false-alarm
 * before each job's first run.
 */
export async function getCronHealth(now: Date = new Date()): Promise<CronHealth[]> {
  const rows = await prisma.setting.findMany({
    where: { OR: [{ key: { startsWith: KEY_PREFIX } }, { key: { startsWith: FIRST_SEEN_PREFIX } }] },
  });
  const lastById = new Map<string, Date>();
  const firstSeenById = new Map<string, Date>();
  for (const r of rows) {
    const at = (r.value as { at?: string } | null)?.at;
    if (!at) continue;
    if (r.key.startsWith(KEY_PREFIX)) lastById.set(r.key.slice(KEY_PREFIX.length), new Date(at));
    else if (r.key.startsWith(FIRST_SEEN_PREFIX)) firstSeenById.set(r.key.slice(FIRST_SEEN_PREFIX.length), new Date(at));
  }
  // Stamp firstSeenAt for any job we're seeing for the first time. Best-effort: a
  // concurrent create or a DB blip is fine, since we use the in-memory `now` anchor
  // for this call regardless. This never throws (observability must not break the page).
  for (const j of CRON_JOBS) {
    if (firstSeenById.has(j.id)) continue;
    firstSeenById.set(j.id, now);
    try {
      await prisma.setting.create({ data: { key: `${FIRST_SEEN_PREFIX}${j.id}`, value: { at: now.toISOString() } } });
    } catch {
      // already created by a concurrent view, or DB unavailable -- ignore.
    }
  }
  return CRON_JOBS.map((j) => {
    const lastSuccessAt = lastById.get(j.id) ?? null;
    const neverRun = lastSuccessAt == null;
    const anchor = lastSuccessAt ?? firstSeenById.get(j.id) ?? now;
    const stale = now.getTime() - anchor.getTime() > j.maxStaleMs;
    return { id: j.id, label: j.label, lastSuccessAt, stale, neverRun };
  });
}
