// src/app/(app)/notifications/page.tsx
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import {
  listNotifications,
  markRead,
  NOTIFICATIONS_PAGE_SIZE,
} from "@/platform/notifications/inbox";
import { markAllReadAction } from "@/platform/notifications/inbox-actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { Button } from "@/platform/ui/button";

function fmtDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
}

type PageProps = { searchParams: Promise<{ page?: string }> };

export default async function NotificationsPage({ searchParams }: PageProps) {
  const { personId } = await requirePersonSession();
  const sp = await searchParams;
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
    const link = String(formData.get("link") ?? "");
    if (id) await markRead(pid, id);
    redirect(link.length > 0 ? link : "/notifications");
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="Everything addressed to you in HAVEN Hub." />

      <form action={markAllAction}>
        <Button type="submit" variant="outline">Mark all as read</Button>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notifications yet.</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-xl border border-border">
          {rows.map((n) => (
            <li key={n.id}>
              <form action={openAction}>
                <input type="hidden" name="id" value={n.id} />
                <input type="hidden" name="link" value={n.link ?? ""} />
                <button
                  type="submit"
                  className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex w-full items-center gap-2">
                    {!n.readAt && (
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-brand" />
                    )}
                    <span className="font-medium text-foreground">{n.title}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">{n.body}</span>
                  <span className="text-xs text-subtle-foreground">{fmtDateTime(n.createdAt)}</span>
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
