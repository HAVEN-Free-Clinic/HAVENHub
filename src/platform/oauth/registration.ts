import { randomBytes } from "node:crypto";
import { prisma } from "@/platform/db";
import { constantTimeEqual } from "@/platform/security";
import { isRegistrableRedirectUri } from "./client";
import { hashToken } from "./tokens";

/**
 * Dynamic client registration (RFC 7591) and client authentication at the
 * token endpoint.
 *
 * Registration is open to anyone, as the MCP spec expects: it is how a client
 * the Hub has never heard of (Cursor, VS Code, a local agent) introduces
 * itself. It grants nothing on its own -- see client.ts -- so the only things
 * worth defending here are the database (rate limits, a size cap, and a sweep
 * of registrations nobody ever approved) and the redirect URIs a client may
 * claim (isRegistrableRedirectUri).
 */

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

const MAX_REDIRECT_URIS = 10;
const MAX_NAME_LENGTH = 100;

/** Per client IP, per warm instance. Mirrors the magic-link limiter's shape. */
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_MAX = 20;
/** Across the whole Hub, counted in the database so every instance agrees. */
const GLOBAL_HOURLY_MAX = 200;
/** A registration no one has approved after this long is deleted. */
const UNUSED_CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ipHits = new Map<string, number[]>();

function ipLimited(ip: string | null, now: number): boolean {
  if (!ip) return false;
  if (ipHits.size > 5000) ipHits.clear();
  const recent = (ipHits.get(ip) ?? []).filter((t) => t > now - IP_WINDOW_MS);
  const limited = recent.length >= IP_MAX;
  if (!limited) recent.push(now);
  ipHits.set(ip, recent);
  return limited;
}

export type RegistrationError = { error: "invalid_redirect_uri" | "invalid_client_metadata" | "rate_limited"; description: string };

export type RegistrationResponse = {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: AuthMethod;
  client_secret?: string;
  client_secret_expires_at?: number;
};

/**
 * Register a client from its RFC 7591 metadata.
 *
 * token_endpoint_auth_method defaults to client_secret_basic when omitted,
 * which is what RFC 7591 section 2 specifies; clients that want to be public
 * (every MCP client that uses PKCE alone) ask for "none" explicitly.
 */
export async function registerClient(
  body: unknown,
  ip: string | null,
  now: Date = new Date(),
): Promise<RegistrationResponse | RegistrationError> {
  if (!body || typeof body !== "object") return { error: "invalid_client_metadata", description: "Expected a JSON object." };
  const b = body as Record<string, unknown>;

  const redirectUris = b.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    return { error: "invalid_redirect_uri", description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.` };
  }
  if (!redirectUris.every((u) => typeof u === "string" && u.length <= 2048 && isRegistrableRedirectUri(u))) {
    return {
      error: "invalid_redirect_uri",
      description: "Each redirect URI must be https, http on a loopback address, or a native app scheme.",
    };
  }

  const method = (b.token_endpoint_auth_method ?? "client_secret_basic") as string;
  if (!(AUTH_METHODS as readonly string[]).includes(method)) {
    return { error: "invalid_client_metadata", description: `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}.` };
  }
  if (Array.isArray(b.grant_types) && !b.grant_types.includes("authorization_code")) {
    return { error: "invalid_client_metadata", description: "grant_types must include authorization_code." };
  }
  if (Array.isArray(b.response_types) && b.response_types.some((t) => t !== "code")) {
    return { error: "invalid_client_metadata", description: "Only the code response type is supported." };
  }
  const clientName = typeof b.client_name === "string" ? b.client_name.trim().slice(0, MAX_NAME_LENGTH) || null : null;

  if (ipLimited(ip, now.getTime())) return { error: "rate_limited", description: "Too many registrations. Try again later." };
  const recent = await prisma.oAuthClient.count({ where: { createdAt: { gt: new Date(now.getTime() - IP_WINDOW_MS) } } });
  if (recent >= GLOBAL_HOURLY_MAX) return { error: "rate_limited", description: "Too many registrations. Try again later." };

  await sweepUnusedClients(now);

  const clientId = `hub_${randomBytes(18).toString("base64url")}`;
  const secret = method === "none" ? null : randomBytes(32).toString("base64url");
  await prisma.oAuthClient.create({
    data: {
      id: clientId,
      clientName,
      redirectUris: redirectUris as string[],
      tokenEndpointAuthMethod: method,
      secretHash: secret ? hashToken(secret) : null,
      createdAt: now,
    },
  });

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(clientName ? { client_name: clientName } : {}),
    redirect_uris: redirectUris as string[],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method as AuthMethod,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  };
}

/**
 * Delete registrations nobody approved within a week. Run opportunistically on
 * each registration, so the table's size is bounded by the registration rate
 * limit rather than growing for as long as the endpoint exists.
 */
export async function sweepUnusedClients(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.oAuthClient.deleteMany({
    where: { lastUsedAt: null, createdAt: { lt: new Date(now.getTime() - UNUSED_CLIENT_TTL_MS) } },
  });
  return count;
}

/** Record that a person approved this client, which exempts it from the sweep. */
export async function markClientUsed(clientId: string, now: Date = new Date()): Promise<void> {
  await prisma.oAuthClient.updateMany({ where: { id: clientId }, data: { lastUsedAt: now } });
}

/**
 * Identify and authenticate the client calling the token endpoint.
 *
 * A metadata-document client (https client_id) and a registered public client
 * ("none") present no secret; PKCE and the code's binding to the client are
 * their proof. A registered confidential client must present its secret by the
 * method it registered with -- a secret-holding client that simply omits the
 * secret is refused, or registering with a secret would protect nothing.
 */
export async function authenticateTokenClient(
  form: URLSearchParams,
  authorization: string | null,
): Promise<{ clientId: string } | { error: "invalid_client"; description: string }> {
  let clientId = form.get("client_id");
  let secret = form.get("client_secret");
  let usedBasic = false;

  const basic = authorization?.match(/^Basic\s+(\S+)$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return { error: "invalid_client", description: "Malformed Basic credentials." };
    clientId = decodeURIComponent(decoded.slice(0, sep));
    secret = decodeURIComponent(decoded.slice(sep + 1));
    usedBasic = true;
  }
  if (!clientId) return { error: "invalid_client", description: "client_id is required." };

  if (clientId.startsWith("https://")) {
    return secret ? { error: "invalid_client", description: "This client does not use a secret." } : { clientId };
  }

  const registered = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
  if (!registered) return { error: "invalid_client", description: "Unknown client." };

  const method = registered.tokenEndpointAuthMethod;
  if (method === "none") {
    return secret ? { error: "invalid_client", description: "This client does not use a secret." } : { clientId };
  }
  if ((method === "client_secret_basic") !== usedBasic) {
    return { error: "invalid_client", description: `This client must authenticate with ${method}.` };
  }
  if (!secret || !registered.secretHash || !constantTimeEqual(hashToken(secret), registered.secretHash)) {
    return { error: "invalid_client", description: "Client authentication failed." };
  }
  return { clientId };
}
