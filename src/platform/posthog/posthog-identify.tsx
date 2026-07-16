"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

/**
 * Identifies the signed-in person to posthog-js and associates their events
 * with the active term group, so client-side analytics (pageviews, autocapture,
 * client exceptions) can be sliced per person and per term. Department is not
 * set here: a person can belong to several departments at once, so there is no
 * single department group (department groups are attached server-side only on
 * events that carry one unambiguous department).
 */
export function PostHogIdentify({
  personId,
  name,
  email,
  termId,
  termName,
}: {
  personId: string;
  name: string | null;
  email: string | null;
  termId?: string | null;
  termName?: string | null;
}) {
  useEffect(() => {
    posthog.identify(personId, {
      name: name ?? undefined,
      email: email ?? undefined,
    });
    if (termId) {
      posthog.group("term", termId, termName ? { name: termName } : undefined);
    }
  }, [personId, name, email, termId, termName]);

  return null;
}
