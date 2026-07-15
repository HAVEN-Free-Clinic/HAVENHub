"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

export function PostHogIdentify({
  personId,
  name,
  email,
}: {
  personId: string;
  name: string | null;
  email: string | null;
}) {
  useEffect(() => {
    posthog.identify(personId, {
      name: name ?? undefined,
      email: email ?? undefined,
    });
  }, [personId, name, email]);

  return null;
}
