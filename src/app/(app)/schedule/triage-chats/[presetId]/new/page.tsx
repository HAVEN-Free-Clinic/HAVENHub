import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { mailConnectionStatus, teamsScopesGranted } from "@/platform/email/oauth";
import { prisma } from "@/platform/db";
import { loadTriageChatDraft } from "@/modules/schedule/services/triage-chat-draft";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { ReviewForm } from "./review-form";

/**
 * A server action inherits the route segment config of the page it is invoked
 * from, and this page's action is `createTriageChatAction`: one chat create, up
 * to twenty sequential member adds, and a message post, every one of them a
 * Graph call with an 8 second budget, on top of a draft load that does its own
 * directory lookups. That is minutes, not the 10 to 15 seconds Vercel allows a
 * function by default, and vercel.json sets no override. Killed mid-loop it
 * leaves a real Teams chat with half its members and the week locked out of the
 * UI, so the ceiling goes to the 300 the cron routes already use.
 */
export const maxDuration = 300;

export function generateMetadata() {
  return buildPageMetadata({
    title: "Create triage chat",
    description: "Review this week's roster and opening message before creating the Teams chat.",
  });
}

export default async function NewTriageChatPage({
  params,
}: {
  params: Promise<{ presetId: string }>;
}) {
  await requirePermission("schedule.manage_triage_chats");
  const { presetId } = await params;

  const draft = await loadTriageChatDraft(presetId);
  if (!draft) notFound();
  // Already created this week: send them to the record rather than offering a
  // Create button the unique constraint would reject.
  if (draft.existingChat) redirect(`/schedule/triage-chats/${presetId}/created`);

  // Check the connection up front. Finding out at the moment of creation, after
  // an ED has reviewed twenty names, is the worst time to learn the mailbox is
  // not connected.
  const status = await mailConnectionStatus();
  const credential = await prisma.mailCredential.findUnique({
    where: { id: "mailer" },
    select: { scope: true },
  });
  const scopesOk = teamsScopesGranted(credential?.scope ?? null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Create ${draft.preset.name} triage chat`}
        description="Everything below comes from this week's schedule. Edit anything before creating."
      />

      {!status.connected && (
        <Alert tone="error">
          No Microsoft account is connected. Connect the mailbox in Admin &gt; Email first.
        </Alert>
      )}
      {status.connected && !scopesOk && (
        <Alert tone="error">
          The connected account is missing the Teams chat permissions. Reconnect it in
          Admin &gt; Email to grant them.
        </Alert>
      )}

      <ReviewForm draft={draft} disabled={!status.connected || !scopesOk} />
    </div>
  );
}
