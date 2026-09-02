import type { Audience, AudienceNode } from "@/platform/email/audience/types";
import { isAudienceGroup } from "@/platform/email/audience/types";

/**
 * Client-side counterparts of the node-path scheme in
 * `@/platform/email/audience/resolve.ts`.
 *
 * Deliberately duplicated rather than imported: resolve.ts reaches straight
 * into prisma, so importing it from a client component would drag the whole
 * query layer into the browser bundle. The two definitions are pinned by tests
 * on both sides against the same literal keys ("root", "0", "1.0"), so a drift
 * shows up as a failing assertion rather than as counts landing on the wrong
 * rows.
 */

/** The whole tree's key, distinct from any index-derived child path. */
export const ROOT_NODE_PATH = "root";

/**
 * The most nodes (root included) the server will count in one request; past it
 * it returns an empty map. Mirrors MAX_COUNTED_NODES in resolve.ts, which is
 * the authority. Held here only so the builder can explain the silence rather
 * than leaving an over-budget tree looking like a failed request.
 */
export const MAX_COUNTED_NODES = 40;

/**
 * The same budget expressed in the units a SENDER counts: rows they added.
 *
 * The server's budget includes the implicit root, which is not a clause anyone
 * added and is not visible as a row. Telling someone with exactly 40 rows on
 * screen that they have "more than 40 conditions and groups" is a statement
 * they can see is false, and it points them at the wrong thing to fix.
 */
export const MAX_COUNTED_CLAUSES = MAX_COUNTED_NODES - 1;

/**
 * The key a node's count is returned under. Root-level children are "0", "1";
 * a child of the node at "1" is "1.0". Mirrors enumerateNodes in resolve.ts.
 */
export function childNodePath(parentPath: string, index: number): string {
  return parentPath === ROOT_NODE_PATH ? String(index) : `${parentPath}.${index}`;
}

/** Every path the server will return a count for, in the same order it walks. */
export function nodePaths(audience: Audience): string[] {
  const out: string[] = [ROOT_NODE_PATH];
  const walk = (nodes: AudienceNode[], prefix: string) => {
    nodes.forEach((node, i) => {
      const path = childNodePath(prefix, i);
      out.push(path);
      if (isAudienceGroup(node)) walk(node.children, path);
    });
  };
  walk(audience.conditions, ROOT_NODE_PATH);
  return out;
}

/**
 * A signature of the tree's SHAPE: its nesting, and every group's connective.
 * Condition fields, operators, and values are deliberately excluded.
 *
 * This is what decides whether a count map may still be shown while a fresh one
 * is in flight, and the distinction is not cosmetic. Path keys are positional,
 * so removing any but the last clause shifts every later sibling down one index
 * and the retained map would paint one row with another row's number. Worse, a
 * group's connective is part of how its count is LABELLED: flip a group from
 * ALL to NONE and the retained number, compiled as an intersection, instantly
 * acquires "(everyone matching none of these)" beside it. That parenthetical is
 * the whole device that stops a sender misreading a widening group, so it must
 * never sit next to a number compiled under a different connective.
 *
 * A pure VALUE edit leaves this signature untouched, which is the case the
 * retain-and-dim behaviour exists for: typing into a text box must not blank
 * every row in the tree on each keystroke.
 *
 * Two things it deliberately does NOT separate, both of which are correct today
 * and one of which is a trap for a future feature:
 *
 * 1. **A sibling REORDER is invisible to it.** Every leaf serialises as ".", so
 *    swapping two sibling leaves (or two sibling groups of identical shape and
 *    connective) leaves the key byte-identical while every count below them
 *    moves to the wrong clause. That is the finding-A harm exactly. It is
 *    unreachable today because GroupEditor offers only update, remove, add
 *    condition and add group, with no move or drag control anywhere. **Anything
 *    that lets a sender reorder clauses must extend this key**, most simply by
 *    folding each leaf's field into its serialisation.
 * 2. **A leaf's OPERATOR is not part of it**, including a flip to a negative
 *    operator. `contains -> notContains` inverts a leaf's match set much as
 *    ALL -> NONE inverts a group's, and the builder's "Negative conditions
 *    widen the audience" note appears in the same paint as the flip, beside the
 *    small pre-flip number. That is still retain-and-dim, and the asymmetry
 *    with the group case is deliberate: what a group's connective changes is
 *    the count's LABEL, so a retained number becomes actively FALSE, whereas an
 *    operator flip changes only the number, leaving it merely stale and already
 *    carrying the provisional cue. Widening the key to cover operators would
 *    drag every field and operator edit into blank-and-refetch and cost the
 *    flicker behaviour for no correctness gain.
 */
export function audienceStructureKey(audience: Audience): string {
  const node = (n: AudienceNode): string =>
    isAudienceGroup(n) ? `${n.match}(${n.children.map(node).join(",")})` : ".";
  return `${audience.match}(${audience.conditions.map(node).join(",")})`;
}
