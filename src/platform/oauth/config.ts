/**
 * The Hub as an OAuth 2.1 authorization server for its own MCP endpoints.
 *
 * Exists so a staff member can connect an MCP client -- Claude, Cursor,
 * VS Code, a local agent -- to a Hub MCP server and have every tool call run
 * AS THEM, with their own permissions: the thing a shared bearer token cannot
 * do. The Fin endpoint (/api/mcp) keeps its shared bearer: its identity comes
 * from the Intercom conversation, not from a person signing in, and nothing
 * here touches it.
 *
 * Any client may connect (see client.ts for the two ways it identifies
 * itself). The protection is the person, not the client: they must sign in
 * with the Hub, hold the resource's permission, and approve the client on a
 * consent screen that shows where access is being sent. Tokens are opaque
 * random strings; only their SHA-256 is stored.
 *
 * Implements the MCP authorization spec, including the specifics Claude's
 * client requires: https://claude.com/docs/connectors/building/authentication
 */

/** Single-use, and only needs to survive one browser redirect. */
export const AUTH_CODE_TTL_SECONDS = 120;
/** Short, so a revoked permission or connection stops a stolen token quickly. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Rotated on every use; a person reconnects after a month of disuse. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * One protected MCP resource: the path it is served at, the scope a token for
 * it carries, and the permission a person must hold to connect it at all.
 *
 * The permission is a gate on CONNECTING, not the tools' authorization. Tools
 * still re-check the ordinary permissions the Hub pages use, on every call.
 */
export type McpResource = {
  path: string;
  scope: string;
  permission: string;
  /** Shown on the consent screen: "<client> wants to read <title> as you". */
  title: string;
};

export const RECRUITMENT_RESOURCE: McpResource = {
  path: "/api/mcp/recruitment",
  scope: "recruitment:read",
  permission: "recruitment.api_access",
  title: "recruitment data (cycles, applications, scores, interviews)",
};

export const MCP_RESOURCES: readonly McpResource[] = [RECRUITMENT_RESOURCE];

/** Paths the discovery documents are served at (rewritten to API routes in next.config.ts). */
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/api/oauth/token";
export const REGISTER_PATH = "/api/oauth/register";

export function resourceByPath(path: string): McpResource | null {
  return MCP_RESOURCES.find((r) => r.path === path) ?? null;
}

export function resourceUrl(origin: string, resource: McpResource): string {
  return `${origin}${resource.path}`;
}

export function protectedResourceMetadataUrl(origin: string, resource: McpResource): string {
  return `${origin}${PROTECTED_RESOURCE_METADATA_PREFIX}${resource.path}`;
}
