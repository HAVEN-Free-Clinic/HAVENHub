import { createHmac } from "node:crypto";
import { config } from "@/platform/config";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { buildAdaptiveClaims } from "@/platform/gitbook/adaptive-claims";

/** Person fields the visitor token needs. */
export type VisitorPerson = { id: string; name: string; contactEmail: string | null };

export interface VisitorToken {
  token: string;
  /** Epoch milliseconds when the token expires (iat + 1h). Convenient for client-side refresh scheduling. */
  expiresAt: number;
}

/** 1 hour, matching GitBook's reference backend. */
const TOKEN_TTL_SECONDS = 60 * 60;

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign an HS256 JWT with the key as a raw UTF-8 secret (GitBook-compatible, no jsonwebtoken dependency). */
export function signJwt(claims: Record<string, unknown>, key: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", key).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/**
 * Mint the adaptive visitor JWT for a signed-in, active person. Shared by the docs
 * redirect flow (/api/gitbook/auth) and the in-app embed token endpoint
 * (/api/gitbook/embed-token), so both issue byte-identical claims.
 *
 * The nested `can` claim is GitBook adaptive content (visitor.claims.can.<module>.<action>).
 * Permission leaves come from the effective-permission set. Data-driven leaves that gate on a
 * capability rather than a permission string (the schedule Builder/Attendings leaves) cannot be
 * derived from permissions, so the caller computes them in the app layer (which may import module
 * code) and passes them via `opts.derived`; platform code stays free of module imports.
 *
 * Throws if GITBOOK_JWT_KEY is unset; callers translate that into a 503.
 */
export async function mintVisitorToken(
  person: VisitorPerson,
  opts: { email?: string | null; derived?: Partial<Record<string, boolean>> } = {}
): Promise<VisitorToken> {
  const { GITBOOK_JWT_KEY } = config;
  if (!GITBOOK_JWT_KEY) {
    throw new Error("GITBOOK_JWT_KEY is not configured");
  }

  const perms = await getEffectivePermissions(person.id);

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const token = signJwt(
    {
      name: person.name,
      email: person.contactEmail ?? opts.email ?? undefined,
      iat: now,
      exp,
      ...buildAdaptiveClaims(perms, opts.derived ?? {}),
    },
    GITBOOK_JWT_KEY
  );

  return { token, expiresAt: exp * 1000 };
}
