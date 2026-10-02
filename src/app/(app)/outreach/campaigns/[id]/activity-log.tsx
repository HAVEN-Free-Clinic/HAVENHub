import { DateTime } from "@/platform/dates/display";
import type { CampaignActivity } from "@/platform/email/campaigns/service";

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  subject: "subject",
  body: "message",
  audience: "audience",
  sendOncePerPerson: "send-once setting",
  sender: "From address",
};

const LIST_OPS: Record<string, string> = {
  include: "added a person to the recipients",
  exclude: "excluded a person from the recipients",
  clearExcluded: "cleared the excluded list",
  paste: "updated the pasted addresses",
  addApplicantCycle: "added a cycle's applicants",
  removeApplicantCycle: "removed a cycle's applicants",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * One sentence per audit row. Exported for its test: the audit rows are
 * written by the service under these exact action names, and a renamed action
 * would otherwise fall through to the raw string without anyone noticing.
 */
export function describeActivity(action: string, after: unknown): string {
  const a = record(after);
  switch (action) {
    case "campaign.update": {
      const fields = Array.isArray(a.fields) ? (a.fields as string[]) : [];
      const named = fields.map((f) => FIELD_LABELS[f] ?? f);
      if (named.length === 0) return "saved the campaign";
      const list =
        named.length === 1
          ? named[0]
          : `${named.slice(0, -1).join(", ")}${named.length > 2 ? "," : ""} and ${named[named.length - 1]}`;
      return `edited the ${list}`;
    }
    case "campaign.list_edit":
      return LIST_OPS[String(a.op)] ?? "edited the recipient list";
    case "campaign.test_send":
      return "sent a test email";
    case "campaign.send": {
      const n = Number(a.recipientCount ?? 0);
      return `sent it to ${n} ${n === 1 ? "recipient" : "recipients"}`;
    }
    case "campaign.schedule":
      return a.scheduleType === "RECURRING" ? "started a recurring schedule" : "scheduled it";
    case "campaign.unschedule":
      return "moved it back to draft";
    case "campaign.cancel":
      return "cancelled the schedule";
    case "campaign.duplicate":
      return "created this campaign as a copy";
    case "campaign.retry_failed": {
      const n = Number(a.count ?? 0);
      return `retried ${n} failed ${n === 1 ? "email" : "emails"}`;
    }
    case "campaign.dispatch_empty":
      return "skipped the scheduled send because the audience matched nobody, and moved it back to draft";
    default:
      return action;
  }
}

export function ActivityLog({ entries }: { entries: CampaignActivity[] }) {
  return (
    <ol className="space-y-2 text-sm">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-wrap gap-x-2 text-foreground-soft">
          <span className="whitespace-nowrap text-muted-foreground">
            <DateTime value={e.at} />
          </span>
          <span>
            <span className="font-medium text-foreground">
              {e.actorName ?? (e.action.startsWith("campaign.dispatch") || e.action === "campaign.send" ? "Scheduler" : "Someone")}
            </span>{" "}
            {describeActivity(e.action, e.after)}
          </span>
        </li>
      ))}
    </ol>
  );
}
