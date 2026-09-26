import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useAuth } from "./auth";
import { NetworkError, SessionExpiredError } from "./oauth";

/** Response shapes of src/app/api/mobile/v1 in the web app. Keep the two in step. */

export type Me = {
  person: { id: string; name: string; email: string };
  activeTerm: { id: string; code: string; name: string } | null;
  memberships: { departmentCode: string; departmentName: string; kind: string }[];
  unreadCount: number;
  modules: { id: string; title: string; url: string }[];
};

export type Shift = {
  /** A clinic date as YYYY-MM-DD. A calendar day, not an instant: never pass it through `new Date()` unadjusted. */
  date: string;
  departmentCode: string;
  departmentName: string;
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW";
  clinicClosed: boolean;
  closedNote: string | null;
  attendings: { name: string; slotLabel: string }[];
};

export type ScheduleResponse = {
  scheduleUrl: string;
  terms: { id: string; code: string; name: string; isLive: boolean; shifts: Shift[] }[];
};

export type Notification = {
  id: string;
  title: string;
  body: string;
  url: string | null;
  read: boolean;
  createdAt: string;
};

export type NotificationsResponse = {
  unreadCount: number;
  page: number;
  hasMore: boolean;
  notifications: Notification[];
};

/** A request the Hub refused for a reason the person should see (403 and friends). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function readResponse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Most often the Vercel firewall's HTML challenge page: see README.md.
    throw new NetworkError("The Hub sent an unexpected response. Try again in a minute.");
  }
  if (!res.ok) {
    const b = body as { error_description?: string };
    if (res.status === 503) throw new NetworkError("The Hub is briefly unavailable. Try again in a minute.");
    throw new ApiError(b.error_description ?? "Something went wrong.", res.status);
  }
  return body as T;
}

export type ApiState<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refreshing: boolean;
  /** Pull-to-refresh. Keeps showing the last data while it loads. */
  reload: () => Promise<void>;
};

/**
 * GET an endpoint, reloading whenever the screen comes back into focus so a
 * tab never shows data older than the last time it was opened.
 */
export function useApi<T>(path: string): ApiState<T> {
  const { apiFetch } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await readResponse<T>(await apiFetch(path));
      setData(next);
      setError(null);
    } catch (err) {
      // A spent session signs the person out; the router takes them to sign-in.
      if (!(err instanceof SessionExpiredError)) setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, path]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const reload = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // `loading` is only the first load: later focus reloads keep showing the last data.
  return { data, error, loading, refreshing, reload };
}
