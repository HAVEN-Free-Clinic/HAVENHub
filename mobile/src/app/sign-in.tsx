import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";

export default function SignIn() {
  const t = useTheme();
  const { signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPress = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: t.brand }]}>
      <View style={styles.hero}>
        <Image source={require("../../assets/haven-logo-white.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="HAVEN Free Clinic" />
        <Text style={styles.title}>HAVEN Hub</Text>
        <Text style={styles.subtitle}>Your shifts, notifications and clinic tools, on your phone.</Text>
      </View>
      <View style={styles.actions}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button label={busy ? "Signing in…" : "Sign in with the Hub"} onPress={onPress} variant="secondary" disabled={busy} />
        <Text style={styles.fine}>You&apos;ll sign in the same way you do on the website, then approve this app.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "space-between" },
  hero: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  logo: { width: 220, height: 80 },
  title: { color: "#fff", fontSize: 30, fontWeight: "700" },
  subtitle: { color: "#d6e8f7", fontSize: 16, textAlign: "center", lineHeight: 22 },
  actions: { gap: 12 },
  error: { color: "#fecaca", fontSize: 15, textAlign: "center" },
  fine: { color: "#d6e8f7", fontSize: 13, textAlign: "center" },
});
