import type { Prisma } from "@prisma/client";
import type { Audience, AudienceNode } from "./types";
import { isAudienceGroup } from "./types";
import { personFieldWhere, type AudienceCtx } from "./person-fields";
import { MATCH_NOBODY } from "./operators";

function compileGroup(
  match: "ALL" | "ANY" | "NONE",
  children: AudienceNode[],
  ctx: AudienceCtx,
): Prisma.PersonWhereInput {
  // Empty group/audience matches NOTHING; never an accidental "everyone" blast.
  //
  // This check MUST stay ahead of the match switch. For ALL/ANY an empty group
  // would merely produce an empty AND/OR, but for NONE it would produce
  // `NOT { OR: [] }` -- vacuously true, i.e. every Person in the table.
  if (children.length === 0) return MATCH_NOBODY;

  const fragments = children.map((node) => compileNodeWhere(node, ctx));

  if (match === "ALL") return { AND: fragments };
  if (match === "ANY") return { OR: fragments };
  // NONE: matches a Person satisfying none of the children.
  return { NOT: { OR: fragments } };
}

/**
 * Compile ONE node of the tree on its own.
 *
 * This is the exact two-way branch compileGroup applies to each of its
 * children, factored out rather than copied: the per-node match counts
 * (countAudienceNodes in resolve.ts) have to count the very fragment a send
 * would compile for that node, so a node's `where` must never come from a
 * second, parallel compiler that could drift from this one. Sharing the
 * function is what makes "the count of a node" and "the meaning of a node" the
 * same statement.
 */
export function compileNodeWhere(node: AudienceNode, ctx: AudienceCtx): Prisma.PersonWhereInput {
  return isAudienceGroup(node)
    ? compileGroup(node.match, node.children, ctx)
    : personFieldWhere(node, ctx);
}

export function compilePersonWhere(audience: Audience, ctx: AudienceCtx): Prisma.PersonWhereInput {
  return compileGroup(audience.match, audience.conditions, ctx);
}
