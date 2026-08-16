import type { ReactNode } from "react";
import { resolveSupportAppId } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";

/**
 * Wraps /onboard/[token]: the emailed contract-signing link for a brand-new
 * recruit. Almost always reached with no session at all -- the whole point of
 * the token is that the recipient has no account yet -- so mode="identified"
 * with no requireActiveMembership relies entirely on the token route's own
 * fallback: no session or no matched Person (401) settles into visitor, and
 * the rare case of an existing member revisiting a completed link while
 * signed in gets identified. No BlockerGate -- that stays (app)-only by
 * design, see blocker-gate.tsx.
 */
export default function OnboardLayout({ children }: { children: ReactNode }) {
  const supportAppId = resolveSupportAppId();
  return (
    <>
      {supportAppId ? <IntercomMessenger appId={supportAppId} mode="identified" /> : null}
      {children}
    </>
  );
}
