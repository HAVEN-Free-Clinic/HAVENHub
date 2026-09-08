import Link from "next/link";
import { requireAnyPermission } from "@/platform/auth/session";
import { listCampaigns } from "@/platform/email/campaigns/service";
import { isoDateKey } from "@/platform/dates";
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
        description="Compose and send ad-hoc bulk emails to a filtered audience."
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
              <TH>Created</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <tbody>
            {campaigns.map((c) => (
              <TR key={c.id}>
                <TD>
                  <TextLink href={`/outreach/campaigns/${c.id}`} className="font-medium">
                    {c.name}
                  </TextLink>
                </TD>
                <TD className="whitespace-nowrap text-muted-foreground">
                  {isoDateKey(c.createdAt)}
                </TD>
                <TD>
                  <Badge tone={STATUS_TONES[c.status] ?? "default"}>
                    {STATUS_LABELS[c.status] ?? c.status}
                  </Badge>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
