import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";

/** Paths reachable without being onboarded: the gate itself, the fix-it pages
 *  for each task, and the auth escape hatches. Prefix-matched so sub-paths
 *  (e.g. /learning/abc) are covered. */
const ONBOARDING_ALLOWLIST = ["/get-started", "/my-info", "/training", "/learning", "/login", "/welcome"];

function isAllowlistedPath(path: string): boolean {
  return ONBOARDING_ALLOWLIST.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Hard gate, enforced from the root layout (app layer, so it may import module
 * code -- platform/auth must not). Sends a gated, not-yet-cleared person to
 * /get-started. No-op when there is no path context (server actions), on
 * allowlisted paths, for exempt users, when there is no active term, or when
 * already onboarded.
 */
export async function enforceOnboardingGate(personId: string): Promise<void> {
  const path = (await headers()).get("x-pathname");
  if (!path || isAllowlistedPath(path)) return;

  const status = await getOnboardingStatus(personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) return;

  redirect("/get-started");
}
