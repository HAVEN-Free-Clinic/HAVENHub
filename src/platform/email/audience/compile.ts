import type { Prisma } from "@prisma/client";
import type { Audience } from "./types";
import { personFieldWhere, type AudienceCtx } from "./person-fields";

export function compilePersonWhere(audience: Audience, ctx: AudienceCtx): Prisma.PersonWhereInput {
  // Empty condition list matches NOTHING — never an accidental "everyone" blast.
  if (audience.conditions.length === 0) return { id: { in: [] } };
  const fragments = audience.conditions.map((c) => personFieldWhere(c, ctx));
  return audience.match === "ALL" ? { AND: fragments } : { OR: fragments };
}
