import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

// AUTH_SECRET is needed to sign a portal cookie the running server will accept.
// Playwright (unlike Next) does not auto-load .env, so fall back to reading it.
function authSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const env = readFileSync(".env", "utf8");
  const m = env.match(/^AUTH_SECRET=['"]?([^'"\n]+)/m);
  if (!m) throw new Error("AUTH_SECRET not found in process.env or .env");
  return m[1];
}

/**
 * Forge the signed `applicant_session` cookie that the recruitment portal issues
 * after a magic-link sign-in. Mirrors `signApplicantCookie` in
 * src/modules/recruitment/services/portal-auth.ts so an e2e test can act as a
 * verified applicant without the emailed link (which the test harness cannot
 * read). Returns a Playwright cookie object scoped to localhost.
 */
export function applicantSessionCookie(email: string) {
  const payload = Buffer.from(
    JSON.stringify({ email: email.trim().toLowerCase(), exp: Date.now() + 60 * 60 * 1000 }),
  ).toString("base64url");
  const sig = createHmac("sha256", authSecret()).update(payload).digest("base64url");
  return {
    name: "applicant_session",
    value: `${payload}.${sig}`,
    domain: "localhost",
    path: "/",
  };
}
