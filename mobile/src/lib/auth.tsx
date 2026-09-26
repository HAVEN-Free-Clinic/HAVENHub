import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { API_BASE, AUTHORIZE_URL, MOBILE_RESOURCE, MOBILE_SCOPE, TOKEN_URL } from "./config";
import { exchangeCode, needsRefresh, refreshTokens, registerClient, SessionExpiredError, NetworkError } from "./oauth";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session-store";

// Closes the sign-in popup when the app runs on the web (a no-op on iOS/Android).
WebBrowser.maybeCompleteAuthSession();

type Status = "loading" | "signedOut" | "signedIn";

type AuthContextValue = {
  status: Status;
  /** Opens the Hub's sign-in and consent page. Resolves once the person is back in the app. */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** fetch() against /api/mobile/v1 as the signed-in person, refreshing the token as needed. */
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const DISCOVERY: AuthSession.DiscoveryDocument = { authorizationEndpoint: AUTHORIZE_URL, tokenEndpoint: TOKEN_URL };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const session = useRef<StoredSession | null>(null);
  // One refresh at a time: refresh tokens rotate, so two concurrent refreshes
  // would spend the same token twice and the second would sign the person out.
  const refreshing = useRef<Promise<StoredSession> | null>(null);

  useEffect(() => {
    loadSession().then((s) => {
      session.current = s;
      setStatus(s ? "signedIn" : "signedOut");
    });
  }, []);

  const signOut = useCallback(async () => {
    session.current = null;
    refreshing.current = null;
    await clearSession();
    setStatus("signedOut");
  }, []);

  const refresh = useCallback(async (): Promise<StoredSession> => {
    const current = session.current;
    if (!current) throw new SessionExpiredError();
    refreshing.current ??= (async () => {
      try {
        const tokens = await refreshTokens({ clientId: current.clientId, refreshToken: current.tokens.refreshToken });
        const next = { ...current, tokens };
        session.current = next;
        await saveSession(next);
        return next;
      } catch (err) {
        if (err instanceof SessionExpiredError) await signOut();
        throw err;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [signOut]);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      let current = session.current;
      if (!current) throw new SessionExpiredError();
      if (needsRefresh(current.tokens)) current = await refresh();

      const send = (token: string) =>
        fetch(`${API_BASE}${path}`, {
          ...init,
          headers: { Accept: "application/json", ...init.headers, Authorization: `Bearer ${token}` },
        }).catch(() => {
          throw new NetworkError();
        });

      let res = await send(current.tokens.accessToken);
      if (res.status === 401) {
        // Revoked or expired early (e.g. a permission change): one refresh, then give up.
        current = await refresh();
        res = await send(current.tokens.accessToken);
        if (res.status === 401) {
          await signOut();
          throw new SessionExpiredError();
        }
      }
      return res;
    },
    [refresh, signOut],
  );

  const signIn = useCallback(async () => {
    const redirectUri = AuthSession.makeRedirectUri({ scheme: "org.havenfreeclinic.hub", path: "oauth" });
    // Register per sign-in rather than once per install: the Hub sweeps
    // registrations nobody approved, so a stored-but-never-used client id
    // could be gone by the time the person tries again.
    const clientId = await registerClient(redirectUri);
    const request = new AuthSession.AuthRequest({
      clientId,
      redirectUri,
      scopes: [MOBILE_SCOPE],
      usePKCE: true,
      extraParams: { resource: MOBILE_RESOURCE },
    });
    const result = await request.promptAsync(DISCOVERY);
    if (result.type !== "success" && result.type !== "error") return; // Closed the browser.
    if (result.type === "error" || !result.params.code) {
      if (result.params.error === "access_denied") return; // They pressed "Don't allow".
      throw new Error(result.params.error_description ?? "Sign-in didn't finish. Try again.");
    }
    const tokens = await exchangeCode({
      clientId,
      code: result.params.code,
      redirectUri,
      codeVerifier: request.codeVerifier ?? "",
    });
    const next = { clientId, redirectUri, tokens };
    await saveSession(next);
    session.current = next;
    setStatus("signedIn");
  }, []);

  const value = useMemo(() => ({ status, signIn, signOut, apiFetch }), [status, signIn, signOut, apiFetch]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
