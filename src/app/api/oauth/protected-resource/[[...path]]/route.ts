import { RECRUITMENT_RESOURCE, resourceByPath } from "@/platform/oauth/config";
import { protectedResourceMetadata } from "@/platform/oauth/metadata";
import { publicOrigin } from "@/platform/oauth/origin";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 metadata for one MCP endpoint. Served at
 * /.well-known/oauth-protected-resource/<mcp path> (the path-suffixed form
 * clients try first) through a rewrite in next.config.ts, which forwards the
 * suffix here as `path`.
 *
 * The bare /.well-known/oauth-protected-resource is the fallback clients probe
 * when the suffixed form 404s; with one protected endpoint it can only mean
 * that one, so it answers for recruitment rather than 404ing.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const resource = path?.length ? resourceByPath(`/${path.join("/")}`) : RECRUITMENT_RESOURCE;
  if (!resource) return Response.json({ error: "Not Found" }, { status: 404 });
  return Response.json(protectedResourceMetadata(publicOrigin(request.headers, request.url), resource));
}
