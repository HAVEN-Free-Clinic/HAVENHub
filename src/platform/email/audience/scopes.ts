/**
 * Audience scopes: named, reusable audience trees that also act as the
 * delegation boundary for outreach campaigns.
 *
 * A scope holds exactly the same `Audience` shape a campaign holds, so scopes
 * and campaigns share one compiler, one builder, and one set of safety
 * invariants. Enforcement (intersecting a scope with a campaign's own audience)
 * lives in resolve.ts, not here: this module only owns storage and grants.
 */
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { roleIdsForPerson } from "@/platform/rbac/engine";
import { isAudience } from "./types";
import type { Audience } from "./types";

export type AudienceScopeView = {
  id: string;
  name: string;
  description: string | null;
  audience: Audience;
  fromEmail: string | null;
  fromName: string | null;
};

export class ScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeValidationError";
  }
}

type ScopeRow = {
  id: string;
  name: string;
  description: string | null;
  audienceJson: unknown;
  fromEmail: string | null;
  fromName: string | null;
};

/**
 * A stored audienceJson that no longer parses becomes an EMPTY audience, which
 * compiles to MATCH_NOBODY. Failing closed matters more here than anywhere else
 * in the engine: this value is a send boundary, so a corrupt one must narrow to
 * nobody rather than be skipped as "no constraint".
 */
function toView(row: ScopeRow): AudienceScopeView {
  const audience: Audience = isAudience(row.audienceJson)
    ? row.audienceJson
    : { recordType: "PERSON", match: "ALL", conditions: [] };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    audience,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
  };
}

function validate(input: { name: string; audience: Audience }): void {
  if (input.name.trim() === "") throw new ScopeValidationError("Name is required.");
  if (!isAudience(input.audience)) throw new ScopeValidationError("Invalid audience.");
}

export async function listScopes(): Promise<AudienceScopeView[]> {
  const rows = await prisma.audienceScope.findMany({ orderBy: { name: "asc" } });
  return rows.map(toView);
}

export async function getScope(id: string): Promise<AudienceScopeView | null> {
  const row = await prisma.audienceScope.findUnique({ where: { id } });
  return row ? toView(row) : null;
}

export async function createScope(
  actorId: string | null,
  input: { name: string; description?: string; audience: Audience },
): Promise<AudienceScopeView> {
  validate(input);
  const row = await prisma.audienceScope.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      audienceJson: input.audience,
      createdById: actorId,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.create",
    entityType: "AudienceScope",
    entityId: row.id,
    after: { name: row.name },
  });
  return toView(row);
}

export async function updateScope(
  actorId: string | null,
  id: string,
  input: { name: string; description?: string; audience: Audience },
): Promise<AudienceScopeView> {
  validate(input);
  const before = await prisma.audienceScope.findUniqueOrThrow({ where: { id } });
  const row = await prisma.audienceScope.update({
    where: { id },
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      audienceJson: input.audience,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.update",
    entityType: "AudienceScope",
    entityId: id,
    before: { name: before.name, audienceJson: before.audienceJson },
    after: { name: row.name, audienceJson: row.audienceJson },
  });
  return toView(row);
}

export async function deleteScope(actorId: string | null, id: string): Promise<void> {
  // Checked here rather than relying on the FK's onDelete: Restrict so the
  // caller gets a typed, explainable error instead of a raw Prisma failure.
  const inUse = await prisma.emailCampaign.count({ where: { scopeId: id } });
  if (inUse > 0) {
    throw new ScopeValidationError(
      `This scope is used by ${inUse} campaign(s). Reassign or delete them first.`,
    );
  }
  await prisma.audienceScope.delete({ where: { id } });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.delete",
    entityType: "AudienceScope",
    entityId: id,
  });
}

export async function grantScope(
  actorId: string | null,
  scopeId: string,
  target: { personId: string } | { roleId: string },
): Promise<void> {
  await prisma.audienceScopeGrant.create({ data: { scopeId, ...target } });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.grant",
    entityType: "AudienceScope",
    entityId: scopeId,
    after: target,
  });
}

export async function revokeScope(actorId: string | null, grantId: string): Promise<void> {
  const grant = await prisma.audienceScopeGrant.delete({ where: { id: grantId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.revoke",
    entityType: "AudienceScope",
    entityId: grant.scopeId,
    before: { personId: grant.personId, roleId: grant.roleId },
  });
}

/**
 * Scopes this person may send under: granted to them directly, or to any role
 * they effectively hold. Deduplicated, because both paths can name one scope.
 */
export async function scopesForPerson(personId: string): Promise<AudienceScopeView[]> {
  const roleIds = await roleIdsForPerson(personId);
  const rows = await prisma.audienceScope.findMany({
    where: {
      grants: {
        some: {
          OR: [{ personId }, ...(roleIds.length ? [{ roleId: { in: roleIds } }] : [])],
        },
      },
    },
    orderBy: { name: "asc" },
  });
  return rows.map(toView);
}
