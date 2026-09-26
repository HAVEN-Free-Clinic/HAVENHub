import * as WebBrowser from "expo-web-browser";
import { Alert, View } from "react-native";
import { Body, Button, Card, ErrorState, Loading, Row, Screen, SectionTitle, Title } from "@/components/ui";
import { useApi, type Me } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { HUB_URL } from "@/lib/config";

/**
 * Everything the app doesn't do natively yet opens on the website, in an
 * in-app browser. The list is the Hub's own nav for this person, so it grows
 * and shrinks with their access exactly as the website's does.
 */
export default function More() {
  const { data, error, loading, refreshing, reload } = useApi<Me>("/me");
  const { signOut } = useAuth();

  if (loading) return <Loading />;
  if (error || !data) return <ErrorState error={error ?? new Error("No data")} onRetry={reload} />;

  const open = (url: string) => void WebBrowser.openBrowserAsync(url);
  const confirmSignOut = () =>
    Alert.alert("Sign out?", "You'll need to sign in again to use the app.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Card>
        <Title>{data.person.name}</Title>
        <Body muted>{data.person.email}</Body>
      </Card>

      <SectionTitle>On the website</SectionTitle>
      <View>
        <Row title="My Info" subtitle="Profile, clearance, certificates" onPress={() => open(`${HUB_URL}/my-info`)} />
        {data.modules.map((m) => (
          <Row key={m.id} title={m.title} onPress={() => open(m.url)} />
        ))}
      </View>
      <Body muted>These open the full Hub. You may be asked to sign in on the website the first time.</Body>

      <SectionTitle>Account</SectionTitle>
      <Row title="Connected apps" subtitle="See or disconnect this app" onPress={() => open(`${HUB_URL}/my-info/connections`)} />
      <View style={{ marginTop: 8 }}>
        <Button label="Sign out" variant="secondary" onPress={confirmSignOut} />
      </View>
    </Screen>
  );
}
