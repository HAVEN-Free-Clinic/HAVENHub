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
        await executeRun(campaign.id, { actorId: null, statusUpdate: { status: "SENT", lastRunAt: now, nextRunAt: null } });
      } else {
        const next = campaign.cronExpr ? nextCronAfter(campaign.cronExpr, now) : null;
        await executeRun(campaign.id, { actorId: null, statusUpdate: { lastRunAt: now, nextRunAt: next } });
      }
      executed++;
    } catch (err) {
      errors++;
      console.error("[campaign-dispatch] run failed", campaign.id, err);
    }
  }
  return { executed, errors };
}
