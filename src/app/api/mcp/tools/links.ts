import { getSetting } from "@/platform/settings/service";

/**
 * An absolute Hub URL for a path, for a tool answer to hand the member.
 *
 * Absolute because Fin renders tool text into a chat that lives outside the
 * Hub: a bare "/get-started/hipaa" is not a link there. Built from the
 * app.baseUrl setting, the same base outbound email uses for its links, so a
 * preview or staging deployment points at itself rather than at production.
 *
 * Every tool that tells a member something is outstanding should also say where
 * to fix it. "You are not cleared" with no next step is the answer that turned
 * into a support ticket (the HIPAA and EHS tickets filed from Intercom in
 * August and September 2026 all had the fix one page away).
 */
export async function hubLink(path: string): Promise<string> {
  const base = await getSetting<string>("app.baseUrl");
  return new URL(path, base).toString();
}
