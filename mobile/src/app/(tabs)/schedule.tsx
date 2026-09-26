import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { View } from "react-native";
import { ShiftCard } from "@/components/shift-card";
import { Body, Button, EmptyState, ErrorState, Loading, Screen, SectionTitle } from "@/components/ui";
import { ApiError, useApi, type ScheduleResponse } from "@/lib/api";
import { todayKey } from "@/lib/dates";
import { HUB_URL } from "@/lib/config";

export default function Schedule() {
  const { data, error, loading, refreshing, reload } = useApi<ScheduleResponse>("/schedule");
  const [showPast, setShowPast] = useState(false);

  if (loading) return <Loading />;
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Screen>
        <EmptyState title="No schedule" body="The schedule isn't part of your Hub access." />
      </Screen>
    );
  }
  if (error || !data) return <ErrorState error={error ?? new Error("No data")} onRetry={reload} />;

  const today = todayKey();
  const openOnWeb = () => void WebBrowser.openBrowserAsync(data.scheduleUrl ?? `${HUB_URL}/schedule`);

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      {data.terms.length === 0 ? (
        <EmptyState title="No shifts yet" body="Your shifts appear here once a schedule is published for your team." />
      ) : null}
      {data.terms.map((term) => {
        const upcoming = term.shifts.filter((s) => s.date >= today);
        const past = term.shifts.filter((s) => s.date < today);
        return (
          <View key={term.id} style={{ gap: 12 }}>
            <SectionTitle>{term.name}</SectionTitle>
            {upcoming.length ? (
              upcoming.map((s) => <ShiftCard key={`${s.date}-${s.departmentCode}`} shift={s} />)
            ) : (
              <Body muted>No upcoming shifts this term.</Body>
            )}
            {showPast ? past.map((s) => <ShiftCard key={`${s.date}-${s.departmentCode}`} shift={s} />) : null}
          </View>
        );
      })}
      {data.terms.some((t) => t.shifts.some((s) => s.date < today)) ? (
        <Button label={showPast ? "Hide past shifts" : "Show past shifts"} variant="secondary" onPress={() => setShowPast((v) => !v)} />
      ) : null}
      <Body muted>Swaps, drop requests and availability are on the website for now.</Body>
      <Button label="Open schedule on the web" variant="secondary" onPress={openOnWeb} />
    </Screen>
  );
}
