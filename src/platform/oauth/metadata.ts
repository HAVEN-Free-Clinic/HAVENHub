import {
  AUTHORIZE_PATH,
  MCP_RESOURCES,
  REGISTER_PATH,
  TOKEN_PATH,
  resourceUrl,
  type McpResource,
} from "./config";

/**
 * RFC 8414 authorization server metadata, served at
 * /.well-known/oauth-authorization-server.
 *
 * The issuer is the Hub's own origin. Both client identification mechanisms
 * are advertised: a client that supports Client ID Metadata Documents uses
 * one (Claude checks client_id_metadata_document_supported AND "none" among
 * the auth methods before it will), and anything else registers at
 * registration_endpoint. offline_access is not advertised: refresh tokens
 * are always issued, so there is nothing for the scope to switch on, and
 * advertising it only widens the consent prompt.
 */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    scopes_supported: MCP_RESOURCES.map((r) => r.scope),
  };
}

/**
 * RFC 9728 protected resource metadata for one MCP endpoint.
 *
 * `resource` must equal the URL a person pastes into Claude, character for
 * character, and `authorization_servers` lists exactly one issuer because
 * Claude only ever reads the first.
 */
export function protectedResourceMetadata(origin: string, resource: McpResource) {
  return {
    resource: resourceUrl(origin, resource),
    authorization_servers: [origin],
    scopes_supported: [resource.scope],
    bearer_methods_supported: ["header"],
    resource_name: `HAVEN Hub ${resource.title}`,
  };
}
