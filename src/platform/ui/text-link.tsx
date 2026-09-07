import type { ReactNode } from "react";
import Link from "next/link";
import { cx } from "./cx";

/**
 * An inline link in running text.
 *
 * Before this, 58 links were drawn in about twenty recipes: `text-brand-fg
 * hover:underline`, `underline underline-offset-2`, `font-medium text-brand-fg
 * hover:underline`, and so on, with focus rings on some and not others.
 *
 * Three of them used `text-brand` rather than `text-brand-fg`, which is a real
 * legibility bug rather than drift. `--color-brand` is Yale Blue in BOTH themes;
 * only `--color-brand-fg` lifts in dark (`color-mix(brand 50%, white)`, see
 * globals.css). So those links rendered near-black-blue on the dark canvas: the
 * "Check in" action on /recruitment/events, the only way back out of the
 * check-in kiosk, and every link inside an onboarding contract's prose, which is
 * a document people are asked to read and sign.
 *
 * ## The base sets no font size, on purpose
 *
 * Callers span `text-xs`, `text-sm` and inherit. This repo has no
 * tailwind-merge, so if the base declared a size, a caller's override of that
 * same property would be Tailwind-emission-order unreliable. The base therefore
 * carries colour, underline and focus ring only, and size comes from `size`
 * (or is inherited from the surrounding text, which is the default).
 *
 * Not for a link-styled BUTTON. Two call sites render an action that way; they
 * are activations, not navigation, and giving them a link's semantics would
 * misannounce them. Leave those as buttons.
 */

const SIZE = {
  /** Inherit from the surrounding text. The default, and the common case. */
  inherit: "",
  xs: "text-xs",
  sm: "text-sm",
} as const;

export type TextLinkSize = keyof typeof SIZE;

export function TextLink({
  href,
  size = "inherit",
  external = false,
  className,
  children,
}: {
  href: string;
  size?: TextLinkSize;
  /** Opens in a new tab with the safe rel pair. Renders a plain <a>. */
  external?: boolean;
  /** Layout only (margins, display). Do not restate colour or size here. */
  className?: string;
  children: ReactNode;
}) {
  const classes = cx(
    "rounded-sm text-brand-fg underline underline-offset-2 hover:text-brand-hover",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
    SIZE[size],
    className,
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={classes}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}
