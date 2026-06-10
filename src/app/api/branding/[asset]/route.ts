import { BRANDING_ASSETS, type BrandingAssetName } from "@/platform/branding/asset-types";
import { readBrandingAsset } from "@/platform/branding/assets";

type RouteContext = { params: Promise<{ asset: string }> };

/**
 * GET /api/branding/[asset] -- public branding asset serving.
 *
 * Unauthenticated by design (branding is public). Serves the admin-uploaded image
 * for "logo"/"favicon", or 302-redirects to the bundled default when none is set.
 * Raster-only uploads + nosniff + a restrictive CSP neutralize any active content.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { asset } = await context.params;
  if (!(BRANDING_ASSETS as readonly string[]).includes(asset)) {
    return new Response("Not found", { status: 404 });
  }
  const name = asset as BrandingAssetName;

  const custom = await readBrandingAsset(name);
  if (!custom) {
    const fallback = name === "logo" ? "/brand/haven-logo-white.png" : "/brand/haven-favicon.png";
    return Response.redirect(new URL(fallback, request.url), 302);
  }

  return new Response(new Uint8Array(custom.bytes), {
    status: 200,
    headers: {
      "Content-Type": custom.contentType,
      "Cache-Control": "public, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
