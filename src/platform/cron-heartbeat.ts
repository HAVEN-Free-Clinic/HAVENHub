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

export type CronHealth = { id: string; label: string; lastSuccessAt: Date | null; stale: boolean };

/**
 * Health of every tracked cron job. `stale` is true only when a job has succeeded
 * before but its last success is older than its threshold -- i.e. a schedule that
 * was firing and then stopped, the real failure mode. A job that has never run
 * (lastSuccessAt null, e.g. right after a fresh deploy) is reported but NOT flagged
 * stale, so a new deployment does not raise a false alarm before each job's first run.
 */
export async function getCronHealth(now: Date = new Date()): Promise<CronHealth[]> {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: KEY_PREFIX } } });
  const byId = new Map<string, Date>();
  for (const r of rows) {
    const at = (r.value as { at?: string } | null)?.at;
    if (at) byId.set(r.key.slice(KEY_PREFIX.length), new Date(at));
  }
  return CRON_JOBS.map((j) => {
    const lastSuccessAt = byId.get(j.id) ?? null;
    const stale = lastSuccessAt != null && now.getTime() - lastSuccessAt.getTime() > j.maxStaleMs;
    return { id: j.id, label: j.label, lastSuccessAt, stale };
  });
}
