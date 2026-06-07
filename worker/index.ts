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

const HEARTBEAT_ID = "mirror-worker";
const OUTBOX_QUEUE = "mirror-outbox";
const RECONCILE_QUEUE = "mirror-reconcile";

function mirrorTarget(): MirrorTarget {
  return {
    enabled: config.AIRTABLE_MIRROR_ENABLED,
    baseId: config.AIRTABLE_MIRROR_BASE_ID ?? "",
    peopleTableId: config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "",
    fieldMap: parseFieldMap(config.AIRTABLE_MIRROR_FIELD_MAP),
  };
}

async function main() {
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on("error", (error: unknown) => console.error("[worker] pg-boss error", error));
  await boss.start();

  await boss.createQueue(OUTBOX_QUEUE);
  await boss.createQueue(RECONCILE_QUEUE);

  // Cron triggers; the drain also loops until empty, so a 1-minute cadence is
  // a latency bound, not a throughput bound.
  await boss.schedule(OUTBOX_QUEUE, "* * * * *");
  await boss.schedule(RECONCILE_QUEUE, "0 6 * * *"); // nightly, 06:00 UTC

  const client = config.AIRTABLE_PAT ? new AirtableClient(config.AIRTABLE_PAT) : null;

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
