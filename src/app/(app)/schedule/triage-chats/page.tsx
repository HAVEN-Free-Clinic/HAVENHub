import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listTriageChatCards } from "@/modules/schedule/services/triage-chat-presets";
import { getActiveTerm } from "@/platform/terms/active-term";
import { selectCurrentClinicDate } from "@/platform/teams/channel-link";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
// buttonClasses, not <Button> wrapping a <Link>: Button renders a real <button>
// and has no asChild, so wrapping would nest a link inside a button. Styling the
// Link is the pattern the rest of the schedule module already uses. "outline" is
// this codebase's secondary-emphasis variant; buttonClasses has no "secondary"
// option (variants are primary/outline/danger/ghost).
import { buttonClasses } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { formatCalendarDate } from "@/platform/dates";

export async function generateMetadata() {
  return buildPageMetadata({
    title: "Triage chats",
    description: "Create the weekly Teams triage group chats from the clinic schedule.",
  });
}

export default async function TriageChatsPage() {
  await requirePermission("schedule.manage_triage_chats");
  const term = await getActiveTerm();
  const clinicDate = term ? selectCurrentClinicDate(term.clinicDates, new Date()) : null;
  const presets = await listTriageChatCards(clinicDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Triage chats"
        description="Create this week's Teams triage group chats. Members and the roster come from the clinic schedule."
        action={
          <Link className={buttonClasses("outline", "md")} href="/schedule/triage-chats/new">
            New preset
          </Link>
        }
      />

      {presets.length === 0 && (
        <Alert tone="info">
          No presets yet. Create one for each weekly chat (for example Ancillary and Clinical).
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {presets.map((preset) => (
          <Card key={preset.id}>
            <div className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold">{preset.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {preset.departmentNames.length} department
                  {preset.departmentNames.length === 1 ? "" : "s"}
                  {clinicDate
                    ? ` - clinic ${formatCalendarDate(clinicDate, { month: "long", day: "numeric" })}`
                    : ""}
                </p>
              </div>

              {!clinicDate && (
                <Alert tone="warning">
                  No upcoming clinic date in the active term, so there is nothing to build.
                </Alert>
              )}

              {preset.existingChat ? (
                <div className="space-y-2">
                  <Alert tone="success">Created for this clinic date.</Alert>
                  <a
                    className={buttonClasses("outline", "md")}
                    href={preset.existingChat.webUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Teams
                  </a>
                </div>
              ) : (
                clinicDate && (
                  <Link
                    className={buttonClasses("primary", "md")}
                    href={`/schedule/triage-chats/${preset.id}/new`}
                  >
                    Review and create
                  </Link>
                )
              )}

              <div>
                <Link
                  className="text-sm underline"
                  href={`/schedule/triage-chats/${preset.id}/edit`}
                >
                  Edit preset
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
