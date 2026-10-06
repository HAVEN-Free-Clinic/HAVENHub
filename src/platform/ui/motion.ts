/**
 * Motion tokens. Every animated primitive imports its timing from here, so the
 * whole app moves with one feel: springs with no bounce, short distances, a
 * light blur when content swaps. No component spells out its own spring.
 *
 * Two channels carry the same feel:
 *
 *   - `spring.*` for Motion (`motion/react`) components: layout, presence,
 *     height morphs, sliding pills.
 *   - `--ease-spring` in globals.css for plain CSS transitions (hover, press,
 *     focus rings, popover entrances). It is a `linear()` sample of the same
 *     critically damped curve, so a CSS hover and a Motion swap settle alike.
 *
 * Reduced motion is handled once, by MotionProvider (`reducedMotion="user"`)
 * for Motion and by a media query around the CSS keyframes.
 */
export const spring = {
  /** Dialog height, view swaps, sliding pills. */
  default: { type: "spring", bounce: 0, duration: 0.35 },
  /** Button press, small indicators, hovers. */
  snappy: { type: "spring", bounce: 0, duration: 0.2 },
  /** Value jumps the eye should follow (a reset, a reorder). */
  soft: { type: "spring", bounce: 0.1, duration: 0.5 },
} as const;

/** How far content travels when it enters or leaves, in px. */
export const slideDistance = 24;

/** Blur applied to content on its way in or out, so text never visibly pops. */
export const swapBlur = "blur(4px)";

/** Scale a pressed control settles at. */
export const pressScale = 0.97;
