import Image from "next/image";

/**
 * Full-bleed Yale-blue brand backdrop: the Physicians Building photo under a
 * layered brand wash, with the center kept brighter so a card floating on top
 * stays legible. Presentational and client-safe (no data access) so any public
 * entry screen (sign-in, application portal) can share one consistent identity.
 * Must sit inside a `relative` container.
 */
export function BrandBackdrop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      <Image
        src="/brand/login-building.webp"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />
      {/* Airy brand wash so the photo reads as atmospheric texture, not drama. */}
      <div className="absolute inset-0 bg-brand/30" />
      <div className="absolute inset-0 bg-gradient-to-b from-brand-deep/55 via-brand/10 to-brand-deep/60" />
      {/* Extra weight in the top-left keeps a white logo legible. */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-deep/45 via-transparent to-transparent" />
    </div>
  );
}
