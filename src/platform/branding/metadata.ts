import type { Metadata } from "next";
import { getSetting } from "@/platform/settings/service";
import { getModule } from "@/platform/modules/registry";

const OG_IMAGE_PATH = "/brand/og-image.jpg";
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
const SEP = " · ";

/**
 * Builds a complete, branded Metadata object (Open Graph + Twitter card) for any
 * page. Returning a full card on every call, rather than relying on Next.js
 * parent-to-child metadata merging, avoids the gotcha where a child segment that
 * defines `openGraph` silently drops the parent's `openGraph.images`.
 *
 * Root pages call this with no title: the title becomes a template so child pages
 * that set a plain-string title read "<Page> · <appName>" in the browser tab.
 * Child pages pass a title; the Open Graph title is composed the same way.
 */
export async function buildPageMetadata(
  opts: { title?: string; description?: string } = {},
): Promise<Metadata> {
  const [appName, orgName, baseUrl] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSetting<string>("branding.orgName"),
    getSetting<string>("app.baseUrl"),
  ]);

  const description = opts.description ?? `The unified platform for ${appName}`;
  const ogTitle = opts.title ? `${opts.title}${SEP}${appName}` : appName;

  return {
    metadataBase: new URL(baseUrl),
    title: opts.title ?? { default: appName, template: `%s${SEP}${appName}` },
    description,
    openGraph: {
      title: ogTitle,
      description,
      siteName: appName,
      type: "website",
      images: [
        { url: OG_IMAGE_PATH, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, alt: orgName },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [OG_IMAGE_PATH],
    },
  };
}

/** Metadata for a top-level module, reusing the module registry's own copy. */
export function moduleMetadata(id: string): Promise<Metadata> {
  const mod = getModule(id);
  return buildPageMetadata({ title: mod?.title, description: mod?.description });
}
