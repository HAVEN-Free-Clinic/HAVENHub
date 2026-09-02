/**
 * Audience scopes: named, reusable audience trees that also act as the
 * delegation boundary for outreach campaigns.
 *
 * A scope holds exactly the same `Audience` shape a campaign holds, so scopes
 * and campaigns share one compiler, one builder, and one set of safety
 * invariants. Enforcement (intersecting a scope with a campaign's own audience)
 * lives in resolve.ts, not here: this module only owns storage and grants.
 */
import { Prisma } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { roleIdsForPerson } from "@/platform/rbac/engine";
import { isAudience, EMPTY_AUDIENCE } from "./types";
import type { Audience } from "./types";
import { normalizeSendingAddress, sendingAddressProblem } from "../sender-identity";

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
    : EMPTY_AUDIENCE;
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

/** The scope's identity columns, normalized, or a refusal. */
type IdentityInput = { fromEmail?: string | null; fromName?: string | null };

/**
 * Turn the submitted identity fields into the columns to write, refusing an
 * address that is malformed or that no transport can DKIM-sign for.
 *
 * Validated HERE, at write time, and not merely when a campaign sends: an
 * identity that cannot be signed, or whose local part is malformed, is a
 * campaign that fails after the sender has already hit Send, at which point the
 * run is claimed and the recipients are enqueued. The check is the same
 * `sendingAddressProblem` the issued-identity path uses -- one function, not two
 * drifting copies -- reported as this module's error type so the scope page's
 * existing ?error= handling picks it up unchanged.
 *
 * Returns {} when the caller supplied neither field, so a form that does not
 * carry them (the create form) cannot blank an identity an admin already set.
 * Clearing is an explicit empty string, which normalizes to null.
 */
function identityData(input: IdentityInput): { fromEmail?: string | null; fromName?: string | null } {
  const data: { fromEmail?: string | null; fromName?: string | null } = {};
  if (input.fromEmail !== undefined) {
    const address = normalizeSendingAddress(input.fromEmail);
    if (address) {
      const reason = sendingAddressProblem(address);
      if (reason) throw new ScopeValidationError(reason);
    }
    data.fromEmail = address;
  }
  if (input.fromName !== undefined) {
    data.fromName = input.fromName?.trim() ? input.fromName.trim() : null;
  }
  return data;
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
  input: { name: string; description?: string; audience: Audience } & IdentityInput,
): Promise<AudienceScopeView> {
  validate(input);
  const row = await prisma.audienceScope.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      audienceJson: input.audience,
      createdById: actorId,
      ...identityData(input),
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
  input: { name: string; description?: string; audience: Audience } & IdentityInput,
): Promise<AudienceScopeView> {
  validate(input);
  const before = await prisma.audienceScope.findUniqueOrThrow({ where: { id } });
  const row = await prisma.audienceScope.update({
    where: { id },
    data: {
      name: input.name.trim(),
      audienceJson: input.audience,
      ...identityData(input),
      // Only touch description when the caller actually supplied the field.
      // The scope detail page's save form never submits one today, so an
      // unconditional write here would silently erase any description ever
      // set on every save.
      ...(input.description !== undefined
        ? { description: input.description.trim() || null }
        : {}),
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.update",
    entityType: "AudienceScope",
    entityId: id,
    before: { name: before.name, audienceJson: before.audienceJson, fromEmail: before.fromEmail },
    after: { name: row.name, audienceJson: row.audienceJson, fromEmail: row.fromEmail },
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
  // The shipped UI builds its person/role options from the full ACTIVE roster
  // with no exclusion of who already holds a grant, and a stale detail page
  // (or a genuine double click) can also race two identical submits, so this
  // unique-constraint violation (AudienceScopeGrant_unique_grant) is one click
  // away in normal use, not an edge case. Translate it into the same typed
  // error every other validation failure in this module already throws,
  // rather than letting a raw Prisma P2002 reach the generic error boundary.
  try {
    await prisma.audienceScopeGrant.create({ data: { scopeId, ...target } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ScopeValidationError("This person or role has already been granted this scope.");
    }
    throw err;
  }
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.grant",
    entityType: "AudienceScope",
    entityId: scopeId,
    after: target,
  });
}

export async function revokeScope(actorId: string | null, grantId: string): Promise<void> {
  // Same shape as grantScope's P2002 handling, for the double-submit /
  // stale-page P2025 case (the grant was already revoked in another tab, or a
  // resubmitted form).
  let grant;
  try {
    grant = await prisma.audienceScopeGrant.delete({ where: { id: grantId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new ScopeValidationError("That grant no longer exists.");
    }
    throw err;
  }
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
