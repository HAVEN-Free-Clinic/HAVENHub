import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useTheme } from "@/lib/theme";

/** A scrolling screen body with pull-to-refresh. */
export function Screen({
  children,
  refreshing = false,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const t = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: t.background }}
      contentContainerStyle={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.brand} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.sectionTitle, { color: t.mutedForeground }]}>{children}</Text>;
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.foreground }]}>{children}</Text>;
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.mutedForeground : t.foregroundSoft }]}>{children}</Text>;
}

export function Pill({ children, tone = "brand" }: { children: ReactNode; tone?: "brand" | "warning" }) {
  const t = useTheme();
  const bg = tone === "warning" ? t.warningBg : t.brandFaint;
  const fg = tone === "warning" ? t.warningFg : t.brand;
  return <Text style={[styles.pill, { backgroundColor: bg, color: fg }]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const t = useTheme();
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? t.brand : t.surface,
          borderColor: primary ? t.brand : t.border,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: primary ? t.onBrand : t.foreground }]}>{label}</Text>
    </Pressable>
  );
}

/** A tappable list row, e.g. a module that opens on the website. */
export function Row({ title, subtitle, onPress }: { title: string; subtitle?: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderColor: t.border, backgroundColor: pressed ? t.brandFaint : "transparent" }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: t.foreground }]}>{title}</Text>
        {subtitle ? <Text style={[styles.body, { color: t.mutedForeground }]}>{subtitle}</Text> : null}
      </View>
      <Text style={{ color: t.mutedForeground, fontSize: 18 }}>›</Text>
    </Pressable>
  );
}

export function Loading() {
  const t = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: t.background }]}>
      <ActivityIndicator color={t.brand} />
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Screen>
      <Card>
        <Title>Couldn&apos;t load this</Title>
        <Body>{error.message}</Body>
        <View style={{ marginTop: 12 }}>
          <Button label="Try again" onPress={onRetry} />
        </View>
      </Card>
    </Screen>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <Title>{title}</Title>
      <Body muted>{body}</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 16, gap: 6 },
  sectionTitle: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 },
  title: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  pill: { alignSelf: "flex-start", fontSize: 12, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden" },
  button: { borderWidth: 1, borderRadius: 12, paddingVertical: 14, alignItems: "center", minHeight: 48 },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  rowTitle: { fontSize: 16, fontWeight: "500" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
