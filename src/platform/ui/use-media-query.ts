"use client";

import { useSyncExternalStore } from "react";

const hasMatchMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * Whether a media query currently matches, kept live. False on the server and
 * during hydration (getServerSnapshot), so markup always agrees with the server
 * render and the client corrects after mount; callers should treat false as the
 * desktop default. Also false where matchMedia does not exist (jsdom).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (!hasMatchMedia()) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => hasMatchMedia() && window.matchMedia(query).matches,
    () => false,
  );
}
