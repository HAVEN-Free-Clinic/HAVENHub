/**
 * The public origin a request arrived on, as the client saw it.
 *
 * Every URL this authorization server advertises (issuer, endpoints, resource)
 * and every URL it later compares against (a token's resource) is built from
 * this, so it must agree between the discovery request, the consent page, and
 * the MCP call. Derived from the request rather than from app.baseUrl on
 * purpose: preview deployments share the production database (see
 * neon-preview-deploys), so a stored base URL would make a preview advertise
 * production's endpoints, and a token issued on one origin would then be
 * honored on the other.
 *
 * Same precedence as mcp-handler's getPublicOrigin (x-forwarded-host, then the
 * Host header), written against a bare Headers so a server component, which
 * has no Request, resolves the identical value.
 */
export function publicOrigin(headers: Headers, fallbackUrl?: string): string {
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  if (host) {
    const proto = forwardedProto || (isLocalHost(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  if (fallbackUrl) return new URL(fallbackUrl).origin;
  throw new Error("Cannot determine the public origin: no Host header.");
}

function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}
