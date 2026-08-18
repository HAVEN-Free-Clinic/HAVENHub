import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { selectCurrentClinicDate } from "@/platform/teams/channel-link";
import { NOT_SELECTED_REASON } from "@/modules/schedule/services/triage-chat-create";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { buttonClasses } from "@/platform/ui/button";
import { RetryMessageForm } from "./retry-message-form";

/**
 * Same reason as the review page: a server action inherits the route segment
 * config of the page it is invoked from, and this page's action is
 * `retryMessageAction`, which posts to Graph. One Graph call is inside the
 * default 10 to 15 second limit on a good day and outside it on a bad one, and a
 * post killed in flight releases its claim only if the function lives long
 * enough to run the release. 300 is the ceiling the cron routes already use.
 */
export const maxDuration = 300;

export function generateMetadata() {
  return buildPageMetadata({
    title: "Triage chat created",
    description: "The weekly Teams triage chat, who was added, and who still needs adding by hand.",
  });
}

export default async function TriageChatCreatedPage({
  params,
}: {
  params: Promise<{ presetId: string }>;
}) {
  await requirePermission("schedule.manage_triage_chats");
  const { presetId } = await params;

  // Derived exactly as the index page derives it, so "this week" means the same
  // Saturday on both screens.
  const term = await getActiveTerm();
  const clinicDate = term ? selectCurrentClinicDate(term.clinicDates, new Date()) : null;
  if (!clinicDate) notFound();

  // Scoped to THIS week and to a chat that really exists in Teams. The newest
  // row by createdAt was wrong twice over: a direct visit before this week's
  // chat exists showed last week's as if it were current, and a create still in
  // flight rendered its own claim row as a finished chat, with "0 people added",
  // an empty Open in Teams link, and a Retry that throws.
  const chat = await prisma.triageChat.findFirst({
    where: { presetId, clinicDate, graphChatId: { not: "" } },
    include: { members: { orderBy: [{ departmentName: "asc" }, { personName: "asc" }] } },
  });
  if (!chat) notFound();

  // addedOk partitions the members, so nobody can be in both lists.
  const added = chat.members.filter((m) => m.addedOk);
  const notAdded = chat.members.filter((m) => !m.addedOk);
  // The alarm is only for people a human now has to add by hand. Someone the ED
  // unticked on the review screen, or who joined the schedule after it opened,
  // is recorded in the list below but is not something to act on.
  const needsHandAdding = notAdded.filter((m) => m.error !== NOT_SELECTED_REASON);

  return (
    <div className="space-y-6">
      <PageHeader title={chat.topic} description={`${added.length} people added.`} />

      <a
        className={buttonClasses("primary", "md")}
        href={chat.webUrl}
        target="_blank"
        rel="noreferrer"
      >
        Open in Teams
      </a>

      {chat.messagePostedAt === null && (
        <Alert tone="warning">
          <div className="space-y-2">
            <p>The chat was created but the opening message was not posted.</p>
            <RetryMessageForm triageChatId={chat.id} />
          </div>
        </Alert>
      )}

      {needsHandAdding.length > 0 && (
        <Alert tone="warning">
          <div className="space-y-1">
            <p>
              {needsHandAdding.length} {needsHandAdding.length === 1 ? "person" : "people"} could
              not be added. Add them by hand in Teams:
            </p>
            <p className="select-all font-medium">
              {needsHandAdding.map((m) => m.personName).join(", ")}
            </p>
          </div>
        </Alert>
      )}

      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Added</h2>
        <ul className="space-y-1 text-sm">
          {added.map((m) => (
            <li key={m.id}>
              {m.personName} <span className="text-muted-foreground">({m.departmentName})</span>
            </li>
          ))}
        </ul>
      </div>

      {notAdded.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Not added</h2>
          <ul className="space-y-1 text-sm">
            {notAdded.map((m) => (
              <li key={m.id}>
                {m.personName} <span className="text-muted-foreground">({m.departmentName})</span>
                {m.error && (
                  <span className="block text-xs text-muted-foreground">{m.error}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link className="text-sm underline" href="/schedule/triage-chats">
        Back to triage chats
      </Link>
    </div>
  );
}
