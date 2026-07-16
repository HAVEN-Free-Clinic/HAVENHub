import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listCampaigns } from "@/platform/email/campaigns/service";
import { isoDateKey } from "@/platform/dates";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { cardClasses } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";

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
  await requirePermission("admin.send_email_campaign");
  const campaigns = await listCampaigns();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email campaigns"
        description="Compose and send ad-hoc bulk emails to a filtered audience."
        action={
          <Link
            href="/admin/email/campaigns/new"
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
            href="/admin/email/campaigns/new"
            className={buttonClasses("primary", "sm")}
          >
            New campaign
          </Link>
        </div>
      ) : (
        <ul className={`${cardClasses({ pad: false })} divide-y`}>
          {campaigns.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-5 py-3">
              <span>
                <Link
                  className="text-sm font-medium underline underline-offset-2"
                  href={`/admin/email/campaigns/${c.id}`}
                >
                  {c.name}
                </Link>
                <span className="ml-2 text-xs text-subtle-foreground">{isoDateKey(c.createdAt)}</span>
              </span>
              <Badge tone={STATUS_TONES[c.status] ?? "default"}>
                {STATUS_LABELS[c.status] ?? c.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
