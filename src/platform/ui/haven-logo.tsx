import type { CSSProperties } from "react";

const MASK_STYLE: CSSProperties = {
  maskImage: "url(/brand/haven-logo-white.png)",
  WebkitMaskImage: "url(/brand/haven-logo-white.png)",
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
  maskPosition: "left center",
  WebkitMaskPosition: "left center",
  backgroundColor: "currentColor",
};

/**
 * The official HAVEN Free Clinic lockup (bilingual wordmark), rendered via CSS
 * mask so one asset serves every color: set the text color and the logo follows
 * (white on the brand panel, Yale Blue on light surfaces).
 * Source asset: public/brand/haven-logo-white.png (1500×490).
 */
export function HavenLogo({ className }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label="HAVEN Free Clinic"
      className={`aspect-[1500/490] ${className ?? ""}`}
      style={MASK_STYLE}
    />
  );
}
