import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button, EmptyState, ErrorState, Loading, Screen } from "@/components/ui";
import { readResponse, useApi, type Notification, type NotificationsResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatTimestamp } from "@/lib/dates";
import { useTheme } from "@/lib/theme";
import { useUnread } from "@/lib/unread";

type Extra = {
  base: NotificationsResponse | null;
  more: Notification[];
  page: number;
  hasMore: boolean;
  readIds: Set<string>;
};

const EMPTY: Extra = { base: null, more: [], page: 1, hasMore: false, readIds: new Set() };

export default function Notifications() {
  const t = useTheme();
  const { apiFetch } = useAuth();
  const { setUnread } = useUnread();
  const first = useApi<NotificationsResponse>("/notifications");
  // Pages after the first ("Load more") and rows marked read since page 1
  // loaded. Both belong to one load of page 1: `base` records which, so a
  // reload starts them over without an effect resetting state.
  const [extra, setExtra] = useState<Extra>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (first.data) setUnread(first.data.unreadCount);
  }, [first.data, setUnread]);

  if (first.loading) return <Loading />;
  if (first.error || !first.data) return <ErrorState error={first.error ?? new Error("No data")} onRetry={first.reload} />;

  const base = first.data;
  const forBase = (e: Extra): Extra => (e.base === base ? e : { ...EMPTY, base, hasMore: base.hasMore });
  const current = forBase(extra);
  const items = [...first.data.notifications, ...current.more].map((n) => (current.readIds.has(n.id) ? { ...n, read: true } : n));

  const run = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const markRead = (body: { id: string } | { all: true }) =>
    run(async () => {
      const res = await readResponse<{ unreadCount: number }>(
        await apiFetch("/notifications/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      setUnread(res.unreadCount);
      const ids = "id" in body ? [body.id] : items.map((n) => n.id);
      setExtra((prev) => {
        const e = forBase(prev);
        return { ...e, readIds: new Set([...e.readIds, ...ids]) };
      });
    });

  const open = async (n: Notification) => {
    if (!n.read) void markRead({ id: n.id });
    if (n.url) await WebBrowser.openBrowserAsync(n.url);
  };

  const loadMore = () =>
    run(async () => {
      setBusy(true);
      try {
        const next = await readResponse<NotificationsResponse>(await apiFetch(`/notifications?page=${current.page + 1}`));
        setExtra((prev) => {
          const e = forBase(prev);
          return { ...e, more: [...e.more, ...next.notifications], page: next.page, hasMore: next.hasMore };
        });
      } finally {
        setBusy(false);
      }
    });

  const anyUnread = items.some((n) => !n.read);

  return (
    <Screen refreshing={first.refreshing} onRefresh={first.reload}>
      {actionError ? <Text style={{ color: t.danger }}>{actionError}</Text> : null}
      {anyUnread ? <Button label="Mark all as read" variant="secondary" onPress={() => void markRead({ all: true })} /> : null}
      {items.length === 0 ? <EmptyState title="You're all caught up" body="Notifications from the Hub will appear here." /> : null}
      <View style={[styles.list, { borderColor: t.border, backgroundColor: t.surface }]}>
        {items.map((n, i) => (
          <Pressable
            key={n.id}
            onPress={() => void open(n)}
            accessibilityRole={n.url ? "link" : "button"}
            accessibilityLabel={`${n.read ? "" : "Unread. "}${n.title}`}
            style={({ pressed }) => [
              styles.item,
              { borderTopColor: t.border, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth },
              pressed && { backgroundColor: t.brandFaint },
            ]}
          >
            <View style={[styles.dot, { backgroundColor: n.read ? "transparent" : t.brand }]} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.title, { color: t.foreground, fontWeight: n.read ? "400" : "600" }]}>{n.title}</Text>
              {n.body ? <Text style={[styles.body, { color: t.foregroundSoft }]}>{n.body}</Text> : null}
              <Text style={[styles.time, { color: t.mutedForeground }]}>{formatTimestamp(n.createdAt)}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      {current.hasMore ? <Button label={busy ? "Loading…" : "Load more"} variant="secondary" disabled={busy} onPress={() => void loadMore()} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: "hidden" },
  item: { flexDirection: "row", gap: 10, padding: 14, alignItems: "flex-start" },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  title: { fontSize: 16 },
  body: { fontSize: 14, lineHeight: 20 },
  time: { fontSize: 12, marginTop: 2 },
});
