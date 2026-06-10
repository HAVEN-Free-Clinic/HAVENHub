/**
 * Build a `:root` CSS rule that overrides the brand color variables from a single
 * admin-chosen hex. Shade variants are derived with CSS color-mix() so the browser
 * computes them (no JS color math). The caller passes a value already validated to
 * #rrggbb by the settings schema, so the interpolation is injection-safe.
 */
export function brandStyleVars(hex: string): string {
  return (
    ":root{" +
    `--color-brand:${hex};` +
    `--color-brand-hover:color-mix(in srgb, ${hex} 88%, black);` +
    `--color-brand-deep:color-mix(in srgb, ${hex} 75%, black);` +
    `--color-brand-light:color-mix(in srgb, ${hex} 18%, white);` +
    `--color-brand-faint:color-mix(in srgb, ${hex} 6%, white);` +
    "}"
  );
}
