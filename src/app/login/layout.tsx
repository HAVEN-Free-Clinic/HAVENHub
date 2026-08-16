import type { ReactNode } from "react";
import { resolveSupportAppId } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";

/**
 * Wraps /login and /login/verify: the Hub's own sign-in surfaces. Always
 * visitor mode, unconditionally -- never a fetch, never a session check. A
 * sign-in page exists to establish WHICH identity a browser gets, so it must
 * not itself boot an identified Messenger, even for a browser that happens to
 * carry a still-valid session cookie (e.g. a stale /login?callbackUrl hit
 * after already signing in elsewhere in another tab). No BlockerGate either --
 * that stays (app)-only by design, see blocker-gate.tsx.
 */
export default function LoginLayout({ children }: { children: ReactNode }) {
  const supportAppId = resolveSupportAppId();
  return (
    <>
      {supportAppId ? <IntercomMessenger appId={supportAppId} mode="visitor" /> : null}
      {children}
    </>
  );
}
