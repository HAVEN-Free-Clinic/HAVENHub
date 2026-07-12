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
 *
 * Pass `standalone: true` for a page that is its own public brand (the
 * application portal): its title renders without the "· <appName>" suffix in
 * both the browser tab and the card, while still using the shared branded image.
 */
export async function buildPageMetadata(
  opts: { title?: string; description?: string; standalone?: boolean } = {},
): Promise<Metadata> {
  const [appName, orgName, baseUrl] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSetting<string>("branding.orgName"),
    getSetting<string>("app.baseUrl"),
  ]);

  const description = opts.description ?? `The unified platform for ${orgName}`;

  // A standalone title (the public application portal is a separate brand) opts
  // out of the "<Page> · <appName>" suffix in both the browser tab and the card.
  const standalone = Boolean(opts.title && opts.standalone);
  let title: Metadata["title"];
  let ogTitle: string;
  if (!opts.title) {
    title = { default: appName, template: `%s${SEP}${appName}` };
    ogTitle = appName;
  } else if (standalone) {
    title = { absolute: opts.title };
    ogTitle = opts.title;
  } else {
    title = opts.title;
    ogTitle = `${opts.title}${SEP}${appName}`;
  }

  return {
    metadataBase: new URL(baseUrl),
    title,
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
