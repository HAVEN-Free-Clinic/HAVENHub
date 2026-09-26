import { checkBotId } from "botid/server";
import { log } from "@/platform/logging";

/**
 * True when Vercel BotID classifies the current request as a bot.
 *
 * Fails open: if the check itself throws (outside a request scope, or the
 * verification service is unreachable) the request is treated as human. Both
 * callers gate a sign-in link, and wrongly refusing a real applicant or member
 * their only way in is worse than letting one scripted request through the
 * existing per-address rate limit.
 *
 * Outside a Vercel production build the library always answers "human".
 * The route must also be listed in BOTID_PROTECTED_ROUTES or every caller is
 * classified as a bot.
 */
export async function isBotRequest(): Promise<boolean> {
  try {
    const verification = await checkBotId();
    return verification.isBot;
  } catch (err) {
    log.warn("[botid] check failed; treating request as human", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
