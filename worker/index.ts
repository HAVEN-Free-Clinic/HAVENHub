// HAVEN Hub background worker: drains the mirror outbox and runs nightly
// reconciliation. Run locally with `npm run worker`. pg-boss v10: queues must
// be created before workers attach; handlers receive an ARRAY of jobs.
import { PgBoss } from "pg-boss";
import { config } from "../src/platform/config";
import { prisma } from "../src/platform/db";
import { AirtableClient } from "../src/platform/airtable/client";
import { drainOutbox, type MirrorTarget } from "../src/platform/airtable/mirror";
import { parseFieldMap } from "../src/platform/airtable/mirror-map";
import { reconcilePeople } from "../src/platform/airtable/reconcile";
import { refreshComplianceMirror } from "../src/platform/compliance/mirror-status";
import { runComplianceReminders } from "../src/platform/email/reminders";
import { drainEmailQueue } from "../src/platform/email/send";
import { resolveEmailTransport } from "../src/platform/email/transport";
import { dispatchDueCampaigns } from "../src/platform/email/campaigns/dispatch";

const HEARTBEAT_ID = "mirror-worker";
const OUTBOX_QUEUE = "mirror-outbox";
const RECONCILE_QUEUE = "mirror-reconcile";
const COMPLIANCE_REFRESH_QUEUE = "compliance-refresh";
const REMINDERS_QUEUE = "compliance-reminders";
const EMAIL_QUEUE = "email-send";
const CAMPAIGN_DISPATCH_QUEUE = "campaign-dispatch";

function mirrorTarget(): MirrorTarget {
  return {
    enabled: config.AIRTABLE_MIRROR_ENABLED,
    baseId: config.AIRTABLE_MIRROR_BASE_ID ?? "",
    peopleTableId: config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "",
    fieldMap: parseFieldMap(config.AIRTABLE_MIRROR_FIELD_MAP),
    hipaaFieldId: config.AIRTABLE_MIRROR_HIPAA_FIELD_ID ?? null,
    statusFieldId: config.AIRTABLE_MIRROR_STATUS_FIELD_ID ?? null,
  };
}

async function main() {
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on("error", (error: unknown) => console.error("[worker] pg-boss error", error));
  await boss.start();

  await boss.createQueue(OUTBOX_QUEUE);
  await boss.createQueue(RECONCILE_QUEUE);
  await boss.createQueue(COMPLIANCE_REFRESH_QUEUE);
  await boss.createQueue(REMINDERS_QUEUE);
  await boss.createQueue(EMAIL_QUEUE);
  await boss.createQueue(CAMPAIGN_DISPATCH_QUEUE);

  // Cron triggers; the drain also loops until empty, so a 1-minute cadence is
  // a latency bound, not a throughput bound.
  await boss.schedule(OUTBOX_QUEUE, "* * * * *");
  // Nightly recompute runs before reconcile so freshly enqueued status changes
  // are drained, then verified by reconcile. 05:30 then 06:00 UTC.
  await boss.schedule(COMPLIANCE_REFRESH_QUEUE, "30 5 * * *");
  await boss.schedule(RECONCILE_QUEUE, "0 6 * * *"); // nightly, 06:00 UTC
  // Daily HIPAA reminder run at 13:00 UTC (about 8am ET), after the nightly
  // compliance refresh so statuses are fresh. Per-person 7-day dedup keeps each
  // person at most weekly even though the job runs daily.
  await boss.schedule(REMINDERS_QUEUE, "0 13 * * *");
  await boss.schedule(EMAIL_QUEUE, "* * * * *");
  // Campaign dispatcher: every minute, run any scheduled/recurring campaigns whose
  // nextRunAt has passed. The enqueued emails drain via the email-send job above.
  await boss.schedule(CAMPAIGN_DISPATCH_QUEUE, "* * * * *");

  const client = config.AIRTABLE_PAT ? new AirtableClient(config.AIRTABLE_PAT) : null;
  // Build the transport once outside the handler so the token cache is shared
  // across all invocations within a worker lifetime.
  const emailTransport = await resolveEmailTransport();

  await boss.work(OUTBOX_QUEUE, async () => {
    if (!client) return;
    let processed: number;
    do {
      processed = await drainOutbox(client, mirrorTarget());
    } while (processed > 0);
  });

  await boss.work(RECONCILE_QUEUE, async () => {
    if (!client) return;
    const corrected = await reconcilePeople(client, mirrorTarget());
    if (corrected > 0) console.log(`[worker] reconciliation corrected ${corrected} record(s)`);
  });

  // Nightly recompute: enqueues Person outbox rows for changed compliance
  // statuses. Gating (mirror enabled, statusFieldId set) lives in the drain, so
  // this runs regardless of mirror state -- when disabled the enqueued rows just
  // drain to no-ops on the next pass.
  await boss.work(COMPLIANCE_REFRESH_QUEUE, async () => {
    const enqueued = await refreshComplianceMirror();
    console.log(`[worker] compliance refresh enqueued ${enqueued} change(s)`);
  });

  // Daily HIPAA compliance reminders: queues volunteer reminders (weekly per
  // person) and director escalations into the email queue.
  await boss.work(REMINDERS_QUEUE, async () => {
    const r = await runComplianceReminders();
    console.log(
      `[worker] compliance reminders sent=${r.remindersSent} escalations=${r.escalationsSent} reset=${r.reset} skipped=${r.skipped}`
    );
  });

  // Email send drain: loops until the queue is empty on each trigger.
  await boss.work(EMAIL_QUEUE, async () => {
    let processed: number;
    let total = 0;
    do {
      processed = await drainEmailQueue(emailTransport);
      total += processed;
    } while (processed > 0);
    if (total > 0) console.log(`[worker] email drain processed ${total} message(s)`);
  });

  // Campaign dispatch: fire any due scheduled/recurring campaigns, re-evaluating
  // their audience against current data on each run.
  await boss.work(CAMPAIGN_DISPATCH_QUEUE, async () => {
    const r = await dispatchDueCampaigns(new Date());
    if (r.executed > 0 || r.errors > 0) {
      console.log(`[worker] campaign dispatch executed=${r.executed} errors=${r.errors}`);
    }
  });

  const beat = async () => {
    try {
      await prisma.workerHeartbeat.upsert({
        where: { id: HEARTBEAT_ID },
        update: { beatAt: new Date() },
        create: { id: HEARTBEAT_ID, beatAt: new Date() },
      });
    } catch (error) {
      console.error("[worker] heartbeat failed", error);
    }
  };
  await beat();
  const heartbeatTimer = setInterval(beat, 30_000);

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    await boss.stop({ graceful: true });
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[worker] running. mirror=${config.AIRTABLE_MIRROR_ENABLED ? "ENABLED" : "disabled"} heartbeat=${HEARTBEAT_ID}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
