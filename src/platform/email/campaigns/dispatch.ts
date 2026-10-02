import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { recordAudit } from "@/platform/audit";
import { executeRun, CampaignAlreadyDispatchedError, CampaignEmptyAudienceError } from "./service";
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
        // refuseEmpty: the audience resolves live at send time, and it can
        // have emptied since the sender scheduled it (everyone offboarded, a
        // condition on a date that has passed). Marking it SENT to nobody is
        // terminal and invisible, so it goes back to draft instead.
        try {
          await executeRun(campaign.id, {
            actorId: null,
            claimWhere: { status: "SCHEDULED" },
            statusUpdate: { status: "SENT", lastRunAt: now, nextRunAt: null },
            refuseEmpty: true,
          });
        } catch (err) {
          if (!(err instanceof CampaignEmptyAudienceError)) throw err;
          const { count } = await prisma.emailCampaign.updateMany({
            where: { id: campaign.id, status: "SCHEDULED" },
            data: { status: "DRAFT", scheduleType: "NOW", scheduledAt: null, nextRunAt: null },
          });
          if (count === 1) {
            await recordAudit({
              action: "campaign.dispatch_empty",
              entityType: "EmailCampaign",
              entityId: campaign.id,
            });
          }
          continue;
        }
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
      if (err instanceof CampaignAlreadyDispatchedError) {
        // Another overlapping pass already claimed this campaign. The atomic
        // claim did its job; this is a benign dedup, not a failure, so don't
        // count it as an error or log it as one.
        continue;
      }
      errors++;
      log.error("[campaign-dispatch] run failed", errorAttrs(err, { campaignId: campaign.id }));
    }
  }
  return { executed, errors };
}
