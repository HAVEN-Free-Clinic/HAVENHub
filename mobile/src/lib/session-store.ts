import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { Tokens } from "./oauth";

/** Everything needed to keep calling the Hub: kept in the Keychain / Android Keystore. */
export type StoredSession = {
  clientId: string;
  redirectUri: string;
  tokens: Tokens;
};

const KEY = "hub.session.v1";

/**
 * SecureStore has no web implementation. The web build is only a development
 * preview (`npm run web`), so it keeps the session in sessionStorage: gone when
 * the tab closes, never written to disk. Phones always use the Keychain /
 * Android Keystore.
 */
const store =
  Platform.OS === "web"
    ? {
        getItemAsync: async (k: string) => globalThis.sessionStorage?.getItem(k) ?? null,
        setItemAsync: async (k: string, v: string) => globalThis.sessionStorage?.setItem(k, v),
        deleteItemAsync: async (k: string) => globalThis.sessionStorage?.removeItem(k),
      }
    : SecureStore;

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const raw = await store.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    // Unreadable (e.g. restored from a backup on a new device): start over.
    await clearSession();
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await store.setItemAsync(KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  try {
    await store.deleteItemAsync(KEY);
  } catch {
    // Nothing stored, or the store is unavailable; either way nothing to clear.
  }
}
