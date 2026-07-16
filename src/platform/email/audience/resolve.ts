import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { loadComplianceStatusMap } from "@/platform/compliance/status";
import { loadClearanceMap, type ClearanceSummary } from "@/platform/clearance";
import type { Audience, AudienceCondition, AudienceNode } from "./types";
import { isAudienceGroup } from "./types";
import { compilePersonWhere } from "./compile";
import { personVariables } from "./variables";

export type Recipient = {
  email: string;
  displayName: string;
  recordType: "PERSON";
  recordId: string;
  variables: Record<string, string>;
};

export type ResolvedAudience = { recipients: Recipient[]; excludedNoEmail: number };

/** Flatten the audience tree to its leaf conditions, for precompute detection. */
function collectConditions(nodes: AudienceNode[]): AudienceCondition[] {
  const out: AudienceCondition[] = [];
  for (const node of nodes) {
    if (isAudienceGroup(node)) out.push(...collectConditions(node.children));
    else out.push(node);
  }
  return out;
}

export async function resolveAudience(audience: Audience): Promise<ResolvedAudience> {
  const activeTerm = await getActiveTerm();
  const conditions = collectConditions(audience.conditions);

  // Compliance status is derived live (newest cert + term end), so it can't be a
  // Prisma predicate. Precompute the per-person status map only when a condition
  // needs it, then let the field compiler resolve selected statuses to ids.
  const needsCompliance = conditions.some((c) => c.field === "complianceStatus");
  const complianceStatusByPerson = needsCompliance
    ? await loadComplianceStatusMap(activeTerm?.endDate ?? null)
    : undefined;

  // Clearance (full onboarding status) is likewise derived. Precompute it per
  // active-term member when an isCleared/learningComplete condition is present.
  // With no active term nobody is cleared, so an empty map matches nobody rather
  // than throwing in the field compiler.
  const needsClearance = conditions.some(
    (c) => c.field === "isCleared" || c.field === "learningComplete",
  );
  let clearanceByPerson: Map<string, ClearanceSummary> | undefined;
  if (needsClearance) {
    if (activeTerm) {
      const memberIds = [
        ...new Set(
          (
            await prisma.termMembership.findMany({
              where: { termId: activeTerm.id, status: "ACTIVE" },
              select: { personId: true },
            })
          ).map((m) => m.personId),
        ),
      ];
      clearanceByPerson = await loadClearanceMap(memberIds, activeTerm.id);
    } else {
      clearanceByPerson = new Map();
    }
  }

  const where = compilePersonWhere(audience, {
    activeTermId: activeTerm?.id ?? null,
    complianceStatusByPerson,
    clearanceByPerson,
  });
  const people = await prisma.person.findMany({
    where,
    select: { id: true, name: true, contactEmail: true },
    orderBy: { name: "asc" },
  });

  const recipients: Recipient[] = [];
  let excludedNoEmail = 0;
  for (const p of people) {
    const email = p.contactEmail?.trim() ?? "";
    if (email === "") { excludedNoEmail++; continue; }
    recipients.push({
      email,
      displayName: p.name,
      recordType: "PERSON",
      recordId: p.id,
      variables: personVariables({ name: p.name }),
    });
  }
  return { recipients, excludedNoEmail };
}
