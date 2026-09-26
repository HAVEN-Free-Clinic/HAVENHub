import { authorizationServerMetadata } from "@/platform/oauth/metadata";
import { publicOrigin } from "@/platform/oauth/origin";

export const dynamic = "force-dynamic";

/**
 * RFC 8414 metadata. Served at /.well-known/oauth-authorization-server through
 * a rewrite in next.config.ts; built per request because the issuer is the
 * request's own origin (see publicOrigin for why).
 */
export async function GET(request: Request): Promise<Response> {
  return Response.json(authorizationServerMetadata(publicOrigin(request.headers, request.url)));
}
