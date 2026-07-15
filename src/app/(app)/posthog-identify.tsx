"use client";
import { useEffect } from "react";
import posthog from "posthog-js";

type Props = {
  personId: string;
  name: string | null;
  email: string | null;
};

export function PostHogIdentify({ personId, name, email }: Props) {
  useEffect(() => {
    posthog.identify(personId, {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    });
  }, [personId, name, email]);

  return null;
}
