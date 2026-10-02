import Link from "next/link";
import { requireAnyPermission } from "@/platform/auth/session";
import { listCampaigns } from "@/platform/email/campaigns/service";
import { DateOnly, DateTime } from "@/platform/dates/display";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { TextLink } from "@/platform/ui/text-link";

/** Human labels for the raw EmailCampaignStatus enum surfaced in the list. */
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  SCHEDULED: "Scheduled",
  ACTIVE: "Recurring",
  CANCELLED: "Cancelled",
};

const STATUS_TONES: Record<string, "default" | "brand" | "success"> = {
  DRAFT: "default",
  SENT: "success",
  SCHEDULED: "brand",
  ACTIVE: "brand",
  CANCELLED: "default",
};

export default async function EmailCampaignsPage() {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  const campaigns = await listCampaigns(actor.personId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email campaigns"
        description="Compose and send emails to a filtered audience. Everyone with access to a campaign's scope can see and edit it."
        action={
          <Link
            href="/outreach/campaigns/new"
            className={buttonClasses("primary", "sm")}
          >
            New campaign
          </Link>
        }
      />

      {campaigns.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Campaigns let you send a one-off or recurring email to a filtered group of people.
          </p>
          <Link
            href="/outreach/campaigns/new"
            className={buttonClasses("primary", "sm")}
          >
            New campaign
          </Link>
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Campaign</TH>
              <TH>Status</TH>
              <TH>Sent / next send</TH>
              <TH>Recipients</TH>
              <TH>Last edited</TH>
            </TR>
          </THead>
          <tbody>
            {campaigns.map((c) => {
              const lastRun = c.runs.reduce<Date | null>(
                (latest, r) => (latest && latest > r.runAt ? latest : r.runAt),
                null,
              );
              const recipients = c.runs.reduce((n, r) => n + r.recipientCount, 0);
              return (
                <TR key={c.id}>
                  <TD>
                    <TextLink href={`/outreach/campaigns/${c.id}`} className="font-medium">
                      {c.name}
                    </TextLink>
                  </TD>
                  <TD>
                    <Badge tone={STATUS_TONES[c.status] ?? "default"}>
                      {STATUS_LABELS[c.status] ?? c.status}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">
                    {/* The next send for anything still on a schedule, else the
                        last time it went out. */}
                    {(c.status === "SCHEDULED" || c.status === "ACTIVE") && c.nextRunAt ? (
                      <>Next: <DateTime value={c.nextRunAt} /></>
                    ) : lastRun ? (
                      <DateTime value={lastRun} />
                    ) : (
                      <span className="text-subtle-foreground">Not sent</span>
                    )}
                  </TD>
                  <TD className="text-muted-foreground">
                    {c.runs.length > 0 ? recipients : <span className="text-subtle-foreground">-</span>}
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">
                    <DateOnly value={c.updatedAt} />
                    {c.updatedBy && <span className="text-subtle-foreground"> by {c.updatedBy.name}</span>}
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
