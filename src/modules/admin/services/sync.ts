/**
 * Sync service: outbox statistics detail, worker heartbeat, drift log, and retry.
 *
 * Permission checks are NOT this service's concern -- pages and server actions
 * gate via requirePermission. Services trust their callers and remain testable
 * in isolation.
 *
 * NOTE: The mirror worker itself (draining the outbox and writing to Airtable)
 * is a separate process. This service only reads its heartbeat and the outbox
 * state, and provides the retry operation for operators.
 */

import type { AuditLog, Outbox } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";

/** Heartbeat staleness threshold in milliseconds. */
const HEARTBEAT_THRESHOLD_MS = 90_000;

/** Maximum rows returned for the failures and drift lists. */
const MAX_LIST_ROWS = 20;

export type SyncOverview = {
  mirrorEnabled: boolean;
  targetBaseId: string | null;
  worker: {
    ok: boolean;
    beatAt: Date | null;
  };
  outbox: {
    pending: number;
    failed: number;
    sentLast24h: number;
  };
  /** Latest 20 FAILED outbox rows, newest first. */
  failures: Outbox[];
  /** Latest 20 mirror.drift_corrected audit entries, newest first. */
  drift: AuditLog[];
};

/**
 * Returns a snapshot of the sync health for the dashboard.
 * Queries run in parallel for low latency.
 */
export async function syncOverview(): Promise<SyncOverview> {
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [heartbeat, pending, failed, sentLast24h, failures, drift] = await Promise.all([
    prisma.workerHeartbeat.findUnique({ where: { id: "mirror-worker" } }),
    prisma.outbox.count({ where: { status: "PENDING" } }),
    prisma.outbox.count({ where: { status: "FAILED" } }),
    prisma.outbox.count({
      where: {
        status: "SENT",
        processedAt: { gte: cutoff24h },
      },
    }),
    prisma.outbox.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: MAX_LIST_ROWS,
    }),
    prisma.auditLog.findMany({
      where: { action: "mirror.drift_corrected" },
      orderBy: { createdAt: "desc" },
      take: MAX_LIST_ROWS,
    }),
  ]);

  const now = Date.now();
  const workerOk =
    heartbeat !== null &&
    now - heartbeat.beatAt.getTime() <= HEARTBEAT_THRESHOLD_MS;

  return {
    mirrorEnabled: await getSetting<boolean>("airtable.mirrorEnabled"),
    targetBaseId: config.AIRTABLE_MIRROR_BASE_ID ?? null,
    worker: {
      ok: workerOk,
      beatAt: heartbeat?.beatAt ?? null,
    },
    outbox: {
      pending,
      failed,
      sentLast24h,
    },
    failures,
    drift,
  };
}

/**
 * Flips all FAILED outbox rows to PENDING, resetting attempts and lastError,
 * so the worker will retry them on its next cycle.
 *
 * Audits the operation with the count of rows reset (only when count > 0).
 * Returns the count of rows that were flipped.
 */
export async function retryFailed(actorPersonId: string): Promise<number> {
  const result = await prisma.outbox.updateMany({
    where: { status: "FAILED" },
    data: {
      status: "PENDING",
      attempts: 0,
      lastError: null,
    },
  });

  const count = result.count;

  if (count > 0) {
    await recordAudit({
      actorPersonId,
      action: "sync.retry_failed",
      entityType: "Outbox",
      after: { count },
    });
  }

  return count;
}
