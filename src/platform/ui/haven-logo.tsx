import type { CSSProperties } from "react";
import { getSetting } from "@/platform/settings/service";
import type { BrandingAsset } from "@/platform/branding/asset-types";

function maskStyle(url: string): CSSProperties {
  return {
    maskImage: `url(${url})`,
    WebkitMaskImage: `url(${url})`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "left center",
    WebkitMaskPosition: "left center",
    backgroundColor: "currentColor",
  };
}

/**
 * The app logo lockup, rendered via CSS mask so one asset serves every color: set
 * the text color and the logo follows (white on the brand panel, brand color on
 * light surfaces). The mask points at the public branding route, which serves the
 * admin-uploaded logo or the bundled default. The `?v=` is a cache-buster.
 */
export async function HavenLogo({ className }: { className?: string }) {
  // Resolve the cache-buster version, but never let a settings/DB failure break
  // the page -- HavenLogo also renders on not-found/error pages. Fall back to the
  // default asset (version 0) when settings can't be read.
  let version = 0;
  try {
    version = (await getSetting<BrandingAsset>("branding.logo")).version;
  } catch {
    // settings unavailable; serve the default logo via version 0
  }
  return (
    <div
      role="img"
      aria-label="Logo"
      className={`aspect-[1500/490] ${className ?? ""}`}
      style={maskStyle(`/api/branding/logo?v=${version}`)}
    />
  );
}
