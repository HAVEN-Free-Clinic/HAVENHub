import { isIP } from "node:net";
import { prisma } from "@/platform/db";
import { getPublicJson, isPrivateAddress } from "./safe-fetch";

export { isPrivateAddress };

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
 * resolved addresses are checked separately, at connect time
 * (publicOnlyLookup), because a name can point anywhere.
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
 * Fetch and validate a client's metadata document.
 *
 * Returns null for anything short of a well-formed document on a public host
 * whose own client_id field names the URL it was fetched from -- the check the
 * CIMD draft requires, so a document cannot claim to be a different client.
 * Redirects are refused: a redirect is how a public URL would be turned into a
 * request to an internal one.
 */
export async function fetchClientMetadata(clientId: string): Promise<ResolvedClient | null> {
  if (!isFetchableClientIdUrl(clientId)) return null;
  try {
    const parsed = parseClientMetadata(clientId, await getPublicJson(clientId));
    return parsed ? { ...parsed, kind: "metadata-document", documentHost: new URL(clientId).host } : null;
  } catch {
    return null;
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
