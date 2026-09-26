import { Link } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { Body, Card, EmptyState, ErrorState, Loading, Pill, Screen, SectionTitle, Title } from "@/components/ui";
import { ShiftCard } from "@/components/shift-card";
import { useApi, type Me, type ScheduleResponse } from "@/lib/api";
import { todayKey } from "@/lib/dates";
import { useUnread } from "@/lib/unread";

export default function Home() {
  const me = useApi<Me>("/me");
  const schedule = useApi<ScheduleResponse>("/schedule");
  const { setUnread } = useUnread();

  useEffect(() => {
    if (me.data) setUnread(me.data.unreadCount);
  }, [me.data, setUnread]);

  if (me.loading) return <Loading />;
  if (me.error || !me.data) return <ErrorState error={me.error ?? new Error("No data")} onRetry={me.reload} />;

  const { person, activeTerm, memberships, unreadCount } = me.data;
  const today = todayKey();
  // A 403 here just means this person has no schedule module; the card is left out.
  const nextShift = schedule.data?.terms.flatMap((term) => term.shifts).find((s) => s.date >= today && !s.clinicClosed);

  return (
    <Screen refreshing={me.refreshing} onRefresh={() => void Promise.all([me.reload(), schedule.reload()])}>
      <View style={{ gap: 4 }}>
        <Title>Hi, {person.name.split(" ")[0] || "there"}</Title>
        <Body muted>{activeTerm ? activeTerm.name : "No active term"}</Body>
      </View>

      {unreadCount > 0 ? (
        <Link href="/notifications" asChild>
          <Card>
            <Title>{unreadCount === 1 ? "1 unread notification" : `${unreadCount} unread notifications`}</Title>
            <Body muted>Tap to read</Body>
          </Card>
        </Link>
      ) : null}

      {schedule.data ? (
        <>
          <SectionTitle>Next shift</SectionTitle>
          {nextShift ? (
            <ShiftCard shift={nextShift} />
          ) : (
            <EmptyState title="No upcoming shifts" body="When you're scheduled, your next shift shows up here." />
          )}
        </>
      ) : null}

      <SectionTitle>Your teams</SectionTitle>
      {memberships.length ? (
        <Card>
          {memberships.map((m) => (
            <View key={`${m.departmentCode}-${m.kind}`} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
              <Body>{m.departmentName}</Body>
              <Pill>{m.kind.toLowerCase()}</Pill>
            </View>
          ))}
        </Card>
      ) : (
        <EmptyState title="No active memberships" body="You aren't on a team in the current term." />
      )}
    </Screen>
  );
}
