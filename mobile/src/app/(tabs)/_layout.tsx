import Ionicons from "@expo/vector-icons/Ionicons";
import type { ColorValue } from "react-native";
import { Tabs } from "expo-router/js-tabs";
import { useTheme } from "@/lib/theme";
import { UnreadProvider, useUnread } from "@/lib/unread";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function TabIcon({ name, color, size }: { name: IconName; color: ColorValue; size: number }) {
  return <Ionicons name={name} color={color as string} size={size} />;
}

function icon(name: IconName) {
  const render = ({ color, size }: { color: ColorValue; size: number }) => <TabIcon name={name} color={color} size={size} />;
  render.displayName = `TabIcon(${name})`;
  return render;
}

function TabNavigator() {
  const t = useTheme();
  const { unread } = useUnread();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: t.brand,
        tabBarInactiveTintColor: t.mutedForeground,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.foreground,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: icon("home-outline") }} />
      <Tabs.Screen name="schedule" options={{ title: "Schedule", tabBarIcon: icon("calendar-outline") }} />
      <Tabs.Screen
        name="notifications"
        options={{
          title: "Notifications",
          tabBarIcon: icon("notifications-outline"),
          tabBarBadge: unread > 0 ? (unread > 99 ? "99+" : unread) : undefined,
        }}
      />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: icon("grid-outline") }} />
    </Tabs>
  );
}

export default function TabLayout() {
  return (
    <UnreadProvider>
      <TabNavigator />
    </UnreadProvider>
  );
}
