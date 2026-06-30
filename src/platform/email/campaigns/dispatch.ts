import { prisma } from "@/platform/db";
import { executeRun } from "./service";
import { nextCronAfter } from "./cron";

export type DispatchSummary = { executed: number; errors: number };

/** Find due scheduled/recurring campaigns and run them. */
export async function dispatchDueCampaigns(now: Date): Promise<DispatchSummary> {
  const due = await prisma.emailCampaign.findMany({
    where: {
      status: { in: ["SCHEDULED", "ACTIVE"] },
      nextRunAt: { not: null, lte: now },
    },
  });

  let executed = 0;
  let errors = 0;
  for (const campaign of due) {
    try {
      if (campaign.status === "SCHEDULED") {
        // The SCHEDULED -> SENT flip is the claim token: a lapping pass re-reads
        // the row as SENT and matches zero rows.
        await executeRun(campaign.id, {
          actorId: null,
          claimWhere: { status: "SCHEDULED" },
          statusUpdate: { status: "SENT", lastRunAt: now, nextRunAt: null },
        });
      } else {
        // A recurring campaign stays ACTIVE, so nextRunAt is the claim token:
        // advancing it past `now` makes a lapping pass's `nextRunAt <= now`
        // predicate match zero rows.
        const next = campaign.cronExpr ? nextCronAfter(campaign.cronExpr, now) : null;
        await executeRun(campaign.id, {
          actorId: null,
          claimWhere: { status: "ACTIVE", nextRunAt: { lte: now } },
          statusUpdate: { lastRunAt: now, nextRunAt: next },
        });
      }
      executed++;
    } catch (err) {
      errors++;
      console.error("[campaign-dispatch] run failed", campaign.id, err);
    }
  }
  return { executed, errors };
}
