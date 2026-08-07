/**
 * The `GET /api/search` response contract.
 *
 * It lives in platform, not in the search module, because both ends of the wire
 * need it: the server builder (src/modules/search/entities.ts, which imports and
 * re-exports this) and the client that draws the response (the command palette).
 * The eslint boundary runs one way only, so platform is the side both can reach.
 * Changing this type changes the wire format: move both sides together.
 */

/**
 * Entity groups, in the order the palette shows them.
 *
 * "Recruitment history" sits next to Cycles because it is the same module's
 * data, and after People because a current member is the more common thing to
 * be looking for. It is spelled out rather than shortened to "History" so the
 * heading still says what it is when it appears on its own.
 */
export const ENTITY_GROUPS = ["People", "Cycles", "Recruitment history", "Requests"] as const;

export type EntityGroup = (typeof ENTITY_GROUPS)[number];

/** One entity result. `sub` is an optional second line, such as a status. */
export type EntityHit = {
  id: string;
  label: string;
  sub: string | null;
  href: string;
  group: EntityGroup;
};
