import { requirePersonSession } from "@/platform/auth/session";
import { getActiveTerm } from "@/platform/terms/active-term";
import { PostHogIdentify } from "./posthog-identify";

/**
 * PostHogIdentify for signed-in shells outside the (app) group, which cannot
 * reuse the (app) layout's call. Without it every browser event on those
 * routes stays on the anonymous posthog-js id and shows as a bare UUID in
 * PostHog: /get-started alone left 169 people anonymous over two days, since a
 * member held at the onboarding gate never reaches (app).
 *
 * Only for layouts whose every page already calls requirePersonSession, so
 * the redirect it can raise never fires here first.
 */
export async function SessionPostHogIdentify() {
  const [person, activeTerm] = await Promise.all([requirePersonSession(), getActiveTerm()]);
  return (
    <PostHogIdentify
      personId={person.personId}
      name={person.name}
      email={person.email}
      termId={activeTerm?.id ?? null}
      termName={activeTerm?.name ?? null}
    />
  );
}
