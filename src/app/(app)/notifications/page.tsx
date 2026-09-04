import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { BellOff } from "lucide-react";
import { requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import {
  listNotifications,
  markRead,
  NOTIFICATIONS_PAGE_SIZE,
} from "@/platform/notifications/inbox";
import { markAllReadAction } from "@/platform/notifications/inbox-actions";
import { getSetting } from "@/platform/settings/service";
import { DateTime } from "@/platform/dates/display";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { Button } from "@/platform/ui/button";
import { EmptyState } from "@/platform/ui/empty-state";

type PageProps = { searchParams: Promise<{ page?: string }> };

export default async function NotificationsPage({ searchParams }: PageProps) {
  const { personId } = await requirePersonSession();
  const sp = await searchParams;
  const appName = await getSetting<string>("branding.appName");
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const { rows, total } = await listNotifications(personId, { page });
  const pageCount = Math.max(1, Math.ceil(total / NOTIFICATIONS_PAGE_SIZE));

  async function markAllAction() {
    "use server";
    await markAllReadAction();
    revalidatePath("/notifications");
  }

  // Mark a single notification read, then go to its link (or back to the list).
  async function openAction(formData: FormData) {
    "use server";
    const { personId: pid } = await requirePersonSession();
    const id = String(formData.get("id") ?? "");
    let target = "/notifications";
    if (id) {
      // Resolve the redirect target from trusted server data (owner-scoped),
      // never from the client-submitted form, to avoid an open redirect.
      const row = await prisma.notification.findFirst({
        where: { id, personId: pid },
        select: { link: true },
      });
      await markRead(pid, id);
      if (row?.link) target = row.link;
    }
    redirect(target);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description={`Everything addressed to you in ${appName}.`} />

      <form action={markAllAction}>
        <Button type="submit" variant="outline">Mark all as read</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title="No notifications yet"
          description={`Anything ${appName} needs to tell you about shifts, approvals and requests shows up here.`}
        />
      ) : (
        <ul className="divide-y divide-border-subtle rounded-xl border border-border">
          {rows.map((n) => (
            <li key={n.id}>
              <form action={openAction}>
                <input type="hidden" name="id" value={n.id} />
                {/* eslint-disable-next-line no-restricted-syntax -- full-width flex-col list-row submit; py/layout overrides of Button base are unreliable without tailwind-merge */}
                <button type="submit" className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-muted">
                  <span className="flex w-full items-center gap-2">
                    {!n.readAt && (
                      <>
                        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-brand" />
                        <span className="sr-only">Unread</span>
                      </>
                    )}
                    <span className="font-medium text-foreground">{n.title}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">{n.body}</span>
                  <span className="text-xs text-subtle-foreground"><DateTime value={n.createdAt} /></span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <Pagination
          page={page}
          pageCount={pageCount}
          hrefFor={(p: number) => `/notifications?page=${p}`}
        />
      )}
    </div>
  );
}
