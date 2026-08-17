import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { buttonClasses } from "@/platform/ui/button";
import { RetryMessageForm } from "./retry-message-form";

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

  const chat = await prisma.triageChat.findFirst({
    where: { presetId },
    orderBy: { createdAt: "desc" },
    include: { members: { orderBy: [{ departmentName: "asc" }, { personName: "asc" }] } },
  });
  if (!chat) notFound();

  const added = chat.members.filter((m) => m.addedOk);
  const failed = chat.members.filter((m) => !m.addedOk);

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

      {failed.length > 0 && (
        <Alert tone="warning">
          <div className="space-y-1">
            <p>
              {failed.length} {failed.length === 1 ? "person" : "people"} could not be added.
              Add them by hand in Teams:
            </p>
            <p className="select-all font-medium">
              {failed.map((m) => m.personName).join(", ")}
            </p>
          </div>
        </Alert>
      )}

      <ul className="space-y-1 text-sm">
        {added.map((m) => (
          <li key={m.id}>
            {m.personName} <span className="text-muted-foreground">({m.departmentName})</span>
          </li>
        ))}
      </ul>

      <Link className="text-sm underline" href="/schedule/triage-chats">
        Back to triage chats
      </Link>
    </div>
  );
}
