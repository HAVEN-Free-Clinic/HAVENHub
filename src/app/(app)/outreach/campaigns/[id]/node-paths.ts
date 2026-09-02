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
 */
export function audienceStructureKey(audience: Audience): string {
  const node = (n: AudienceNode): string =>
    isAudienceGroup(n) ? `${n.match}(${n.children.map(node).join(",")})` : ".";
  return `${audience.match}(${audience.conditions.map(node).join(",")})`;
}
