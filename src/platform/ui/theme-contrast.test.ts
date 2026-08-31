/**
 * WCAG AA contrast guard for the neutral text/background token pairs, in BOTH themes.
 *
 * Exists because of audit 14. `--color-subtle-foreground` had been tuned in dark mode
 * against `surface` (#0f172a), where it cleared AA at 4.56:1. But `muted` (#1e293b) is
 * the LIGHTEST of the three dark backgrounds, and the shared Table header pairs exactly
 * those two: THead paints `bg-muted` and the header cell text is `text-subtle-foreground`.
 * On that pair the same ink measured 3.74:1, so every column header of every table in the
 * app failed AA in dark mode, and nothing in the repo could notice.
 *
 * Reads the real stylesheet rather than a copy of the values, so editing a token without
 * re-checking it fails here instead of shipping. Sweeping every neutral ink against every
 * neutral background (rather than just the one pair the audit found) is deliberate: the
 * defect was not a bad value, it was a value checked against only one of the backgrounds
 * it is used on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { THEAD_BG_CLASS, TH_TEXT_CLASS } from "./table";
import { BADGE_TONE_CLASSES } from "./badge";

const CSS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

/** Declarations inside `@theme { ... }`: the light theme, and the base for dark. */
function themeBlock(): string {
  const m = /@theme\s*\{([^}]*)\}/.exec(CSS);
  if (!m) throw new Error("globals.css: no @theme block found");
  return m[1];
}

/**
 * Declarations inside every `html.dark { ... }` rule, concatenated. There is more than
 * one (module accent hues, then the theme itself), and a later one wins, which is also
 * how the browser resolves them.
 */
function darkBlocks(): string {
  // `html\.dark\s*\{` deliberately requires the brace to follow the selector directly,
  // so the descendant rules (`html.dark .glass-panel { ... }`) are not swept in.
  const out: string[] = [];
  for (const m of CSS.matchAll(/html\.dark\s*\{([^}]*)\}/g)) out.push(m[1]);
  if (out.length === 0) throw new Error("globals.css: no html.dark block found");
  return out.join("\n");
}

/** Hex-valued --color-* declarations only. color-mix()/var() values are not comparable here. */
function hexTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}

const light = hexTokens(themeBlock());
const dark = { ...light, ...hexTokens(darkBlocks()) };

function relativeLuminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const INKS = ["foreground", "foreground-soft", "muted-foreground", "subtle-foreground"] as const;

/**
 * Status inks, swept over the same backgrounds for the same reason.
 *
 * These used to be exempt: while Badge carried its tone as a 6px dot, these colors
 * were non-text graphics and only owed 3:1. The Badge restyle folded the tone into
 * the label, so they are 11px text everywhere now and owe 4.5:1. At the moment of
 * that change all three light values failed on `canvas` -- green-700 4.43, amber-700
 * 4.43, red-600 4.26 -- because they had been tuned against white, and canvas
 * (#eef1f5) is darker than white. Any status label sitting outside a card (a page
 * header action, a chip cluster on the page background) was below AA.
 *
 * `brand-fg` is deliberately absent: it resolves through var()/color-mix() off an
 * admin-configurable brand hue, so there is no fixed hex here to assert.
 */
const STATUS_INKS = ["success-foreground", "warning-foreground", "critical-foreground"] as const;
const BACKGROUNDS = ["surface", "muted", "canvas"] as const;

/** Body text, not large text: the table header this guards is text-xs. */
const AA_BODY_TEXT = 4.5;

describe("contrastRatio", () => {
  it("matches the WCAG reference values at both ends of the scale", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // Order must not matter.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#000000"), 5);
  });
});

describe("globals.css token parsing", () => {
  it("resolves every neutral token in both themes, so the sweep below cannot pass vacuously", () => {
    for (const token of [...INKS, ...STATUS_INKS, ...BACKGROUNDS]) {
      expect(light[token], `light --color-${token}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(dark[token], `dark --color-${token}`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    // The dark theme must actually override the neutrals, not silently inherit light ones.
    expect(dark["subtle-foreground"]).not.toBe(light["subtle-foreground"]);
    expect(dark.muted).not.toBe(light.muted);
    // Same for the status inks: light darkens them, dark lifts them. A dark theme
    // that inherited the light values would be measuring the wrong colors below.
    for (const ink of STATUS_INKS) {
      expect(dark[ink], `dark --color-${ink} must override light`).not.toBe(light[ink]);
    }
  });
});

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme neutral text contrast", (_themeName, tokens) => {
  for (const ink of [...INKS, ...STATUS_INKS]) {
    for (const bg of BACKGROUNDS) {
      it(`text-${ink} on bg-${bg} clears WCAG AA for body text`, () => {
        expect(contrastRatio(tokens[ink], tokens[bg])).toBeGreaterThanOrEqual(AA_BODY_TEXT);
      });
    }
  }
});

describe("Table header, the pair audit 14 found failing", () => {
  it("still pairs the exact tokens this test guards", () => {
    // If the header ever repaints itself in different tokens, the sweep above stops
    // covering it and this line is what says so.
    expect(THEAD_BG_CLASS).toBe("bg-muted");
    expect(TH_TEXT_CLASS).toBe("text-subtle-foreground");
  });

  it("clears AA in dark mode, where it measured 3.74:1", () => {
    expect(contrastRatio(dark["subtle-foreground"], dark.muted)).toBeGreaterThanOrEqual(AA_BODY_TEXT);
  });

  it("still clears AA in light mode, so the dark fix did not trade one theme for the other", () => {
    expect(contrastRatio(light["subtle-foreground"], light.muted)).toBeGreaterThanOrEqual(AA_BODY_TEXT);
  });
});

describe("Badge tones, the pair that made the status inks text", () => {
  it("still paints its tone with the *-foreground text variants, not the vivid fills", () => {
    // If Badge ever repaints itself in --color-success/warning/critical (the 3:1
    // icon-and-fill tokens) the sweep above stops covering what actually renders,
    // and every status chip silently drops back under AA. This line is what says so.
    expect(BADGE_TONE_CLASSES.success).toBe("text-success-foreground");
    expect(BADGE_TONE_CLASSES.warning).toBe("text-warning-foreground");
    expect(BADGE_TONE_CLASSES.critical).toBe("text-critical-foreground");
    expect(BADGE_TONE_CLASSES.default).toBe("text-muted-foreground");
  });

  it("clears AA for every tone on every background it can sit on, in both themes", () => {
    for (const [themeName, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const ink of STATUS_INKS) {
        for (const bg of BACKGROUNDS) {
          expect(
            contrastRatio(tokens[ink], tokens[bg]),
            `${themeName}: text-${ink} on bg-${bg}`,
          ).toBeGreaterThanOrEqual(AA_BODY_TEXT);
        }
      }
    }
  });
});

/**
 * `--color-brand-fg` in dark mode is a color-mix(), not a hex, so the sweep above
 * skips it -- and it is text: nav links, breadcrumbs, the active tab, and (since the
 * Badge restyle) every `tone="brand"` chip label. Resolving the mix here is what
 * keeps it inside the guard.
 *
 * The brand hue is admin-configurable, so this can only assert the shipped default
 * (Yale navy). An admin who picks a very light brand can still land under AA; that
 * is a product decision this test cannot make for them. What it does catch is the
 * mix percentage drifting back down, which is how it failed: at 55% the default
 * resolved to 4.41:1 on `muted`.
 */
describe("dark brand-fg, resolved through its color-mix", () => {
  /** `color-mix(in srgb, X p%, white)` -- sRGB mixing is a plain channel-wise lerp. */
  function mixWithWhite(hex: string, percent: number): string {
    const n = parseInt(hex.slice(1), 16);
    const ch = (shift: number) =>
      Math.round((((n >> shift) & 0xff) * percent) / 100 + (255 * (100 - percent)) / 100);
    return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
  }

  /** Reads the live declaration so editing the percentage re-runs this assertion. */
  function darkBrandFgPercent(): number {
    const m = /--color-brand-fg:\s*color-mix\(in srgb, var\(--color-brand\) (\d+)%, white\)/.exec(
      darkBlocks(),
    );
    if (!m) throw new Error("globals.css: dark --color-brand-fg is no longer the expected color-mix");
    return Number(m[1]);
  }

  it("mixes channel-wise in sRGB, matching how a browser resolves it", () => {
    expect(mixWithWhite("#000000", 100)).toBe("#000000");
    expect(mixWithWhite("#000000", 0)).toBe("#ffffff");
    expect(mixWithWhite("#00356b", 50)).toBe("#809ab5");
  });

  it("clears AA as text on every dark background, for the default brand", () => {
    const ink = mixWithWhite(light.brand, darkBrandFgPercent());
    for (const bg of BACKGROUNDS) {
      expect(contrastRatio(ink, dark[bg]), `dark text-brand-fg on bg-${bg}`).toBeGreaterThanOrEqual(
        AA_BODY_TEXT,
      );
    }
  });
});
