/**
 * The `GET /api/search` response contract.
 *
 * It lives in platform, not in the search module, because both ends of the wire
 * need it: the server builder (src/modules/search/entities.ts, which imports and
 * re-exports this) and the client that draws the response (the command palette).
 * The eslint boundary runs one way only, so platform is the side both can reach.
 * Changing this type changes the wire format: move both sides together.
 */

/** Entity groups, in the order the palette shows them. */
export const ENTITY_GROUPS = ["People", "Cycles", "Requests"] as const;

export type EntityGroup = (typeof ENTITY_GROUPS)[number];

/** One entity result. `sub` is an optional second line, such as a status. */
export type EntityHit = {
  id: string;
  label: string;
  sub: string | null;
  href: string;
  group: EntityGroup;
};
