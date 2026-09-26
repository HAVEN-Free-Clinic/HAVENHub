import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { prisma } from "@/platform/db";

/**
 * Who is asking: resolving an OAuth client_id to its registration.
 *
 * Any MCP client may connect, by either of the two mechanisms the MCP
 * authorization spec defines:
 *
 *   - A Client ID Metadata Document (CIMD): the client_id is an https URL and
 *     the document at it lists the client's redirect URIs. Claude uses this.
 *   - Dynamic client registration (RFC 7591): the client POSTs its metadata to
 *     /api/oauth/register first and gets back a random client_id. Cursor,
 *     VS Code, MCP Inspector and most local agents use this.
 *
 * Neither grants anything. What protects the data is that a real person has to
 * sign in, hold the resource's permission, and approve the specific client on
 * the consent screen -- which is why that screen shows the exact host access
 * is sent to, and labels a client's own name as unverified.
 */

export type ResolvedClient = {
  clientId: string;
  /** Self-asserted by the client; display only, never trusted. */
  clientName: string | null;
  redirectUris: string[];
  kind: "metadata-document" | "registered";
  /** For a metadata document, the host serving it -- the one verified fact about who the client is. */
  documentHost: string | null;
};

/** Cap on how long authorize waits on the client's host; Claude allows 10s end to end. */
const FETCH_TIMEOUT_MS = 4_000;
/** A metadata document is a few hundred bytes. Anything large is not one. */
const MAX_DOCUMENT_BYTES = 16_384;

/** Resolve a client_id from the authorize endpoint, or null if it is unknown or unverifiable. */
export async function resolveClient(clientId: string): Promise<ResolvedClient | null> {
  if (!clientId) return null;
  if (clientId.startsWith("https://")) return fetchClientMetadata(clientId);
  const registered = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
  if (!registered) return null;
  return {
    clientId,
    clientName: registered.clientName,
    redirectUris: registered.redirectUris,
    kind: "registered",
    documentHost: null,
  };
}

/**
 * Whether a client_id URL is safe to fetch at all: https, default port, no
 * credentials or fragment, and a host name rather than an IP literal. The
 * resolved addresses are checked separately (assertPublicHost), because a
 * name can point anywhere.
 */
export function isFetchableClientIdUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hash === "" &&
    isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 &&
    url.hostname.includes(".")
  );
}

/**
 * Whether an IP address is one the Hub must never be made to request: loopback,
 * private, link-local (including cloud metadata at 169.254.169.254), carrier
 * NAT, multicast, unspecified, and their IPv6 counterparts. Opening metadata
 * documents to any host turns the authorize endpoint into something anyone can
 * point at a URL of their choosing; this is what keeps that from reaching
 * anything but the public internet.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

async function assertPublicHost(hostname: string): Promise<boolean> {
  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Fetch and validate a client's metadata document.
 *
 * Returns null for anything short of a well-formed document on a public host
 * whose own client_id field names the URL it was fetched from -- the check the
 * CIMD draft requires, so a document cannot claim to be a different client.
 * Redirects are refused rather than followed: a redirect is how a public URL
 * would be turned into a fetch of an internal one after the host check passed.
 */
export async function fetchClientMetadata(clientId: string): Promise<ResolvedClient | null> {
  if (!isFetchableClientIdUrl(clientId)) return null;
  const { hostname, host } = new URL(clientId);
  if (!(await assertPublicHost(hostname))) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(clientId, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_DOCUMENT_BYTES) return null;
    const parsed = parseClientMetadata(clientId, JSON.parse(text));
    return parsed ? { ...parsed, kind: "metadata-document", documentHost: host } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Pure half of fetchClientMetadata, separated so the validation is testable without a network. */
export function parseClientMetadata(
  clientId: string,
  doc: unknown,
): { clientId: string; clientName: string | null; redirectUris: string[] } | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return null;
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.every((u) => typeof u === "string")) return null;
  return {
    clientId,
    clientName: typeof d.client_name === "string" ? d.client_name.slice(0, 100) : null,
    redirectUris: d.redirect_uris as string[],
  };
}

/**
 * URI schemes a redirect may never use, even though RFC 8252 lets native apps
 * register their own (cursor://, vscode://). These would run script, read
 * local files, or send the code in clear text across the network.
 */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ws:", "wss:", "ftp:"]);

/**
 * Whether a redirect URI is acceptable to REGISTER: https anywhere, http only
 * to a loopback address (a local app), or a native app's private-use scheme.
 * No fragments (RFC 6749 section 3.1.2).
 */
export function isRegistrableRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopback(url.hostname);
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  // A private-use scheme: letters, digits, + - . only (RFC 3986), and not a bare word
  // like "mailto:" that a browser would hand to some other program.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol.length > 3 && url.protocol !== "mailto:";
}

/**
 * Whether a requested redirect_uri is one the client registered.
 *
 * Exact string match, except that a loopback registration (http://localhost/...,
 * http://127.0.0.1/..., http://[::1]/...) matches any port: local clients bind
 * an ephemeral port per session, and RFC 8252 section 7.3 requires port-agnostic
 * matching for loopback IPs. Applied to "localhost" too because Claude Code's
 * own metadata document declares it.
 */
export function redirectUriAllowed(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !isLoopback(req.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        reg.protocol === "http:" &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
