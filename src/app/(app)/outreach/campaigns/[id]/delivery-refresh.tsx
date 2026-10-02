"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 10_000;

/**
 * Re-renders the campaign page while emails are still queued, so the delivery
 * counts tick up on their own. Graph delivers about 30 a minute, so a few
 * hundred recipients take minutes to drain and a static page looked stuck.
 * Renders nothing; stops as soon as the server reports nothing pending (the
 * parent stops mounting it).
 */
export function DeliveryRefresh() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
