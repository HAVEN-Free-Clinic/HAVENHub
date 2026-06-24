"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell } from "lucide-react";
import { markReadAction, markAllReadAction } from "@/platform/notifications/inbox-actions";

type Item = {
  id: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { unreadCount: number; recent: Item[] };
      setCount(json.unreadCount);
      setItems(json.recent);
    } catch {
      // Network hiccup: leave the last known state.
    }
  }, []);

  // Initial load + light poll.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function openItem(item: Item) {
    setOpen(false);
    if (!item.readAt) {
      await markReadAction(item.id);
      await refresh();
    }
    if (item.link) router.push(item.link);
  }

  async function markAll() {
    await markAllReadAction();
    await refresh();
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void refresh();
        }}
        aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <Bell aria-hidden className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-critical px-1 text-[10px] font-semibold leading-none text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="glass-panel absolute right-0 top-10 z-40 w-80 overflow-hidden rounded-xl border border-border shadow-lg">
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
            <span className="text-sm font-semibold text-foreground">Notifications</span>
            {count > 0 && (
              <button
                type="button"
                onClick={() => void markAll()}
                className="text-xs font-medium text-brand-fg hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No notifications yet.
              </p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openItem(item)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-4 py-2.5 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex w-full items-center gap-2">
                    {!item.readAt && (
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                    )}
                    <span className="text-sm font-medium text-foreground">{item.title}</span>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span>
                  <span className="text-[11px] text-subtle-foreground">{timeAgo(item.createdAt)}</span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-border-subtle px-4 py-2 text-center">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-brand-fg hover:underline"
            >
              View all
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
