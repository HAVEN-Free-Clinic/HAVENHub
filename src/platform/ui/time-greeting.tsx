"use client";

import { useSyncExternalStore } from "react";

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

// The greeting never changes after mount, so the store never notifies.
const noopSubscribe = () => () => {};

/**
 * Renders the time-aware greeting word using the DEVICE's timezone.
 *
 * The greeting can't be computed correctly on the server: a Server Component's
 * `new Date()` uses the server's timezone (UTC on Vercel), so a member in the
 * afternoon Eastern could see "Good evening". useSyncExternalStore reads the
 * server-computed `initial` during SSR and the first client render (so there is
 * no hydration mismatch), then swaps to the device-local greeting after
 * hydration -- without a state-updating effect.
 */
export function TimeGreeting({ initial }: { initial: string }) {
  const greeting = useSyncExternalStore(
    noopSubscribe,
    () => greetingForHour(new Date().getHours()),
    () => initial,
  );

  return <>{greeting}</>;
}
