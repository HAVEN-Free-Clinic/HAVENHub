import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { loadComplianceStatusMap } from "@/platform/compliance/status";
import type { Audience } from "./types";
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

export async function resolveAudience(audience: Audience): Promise<ResolvedAudience> {
  const activeTerm = await getActiveTerm();

  // Compliance status is derived live (newest cert + term end), so it can't be a
  // Prisma predicate. Precompute the per-person status map only when a condition
  // needs it, then let the field compiler resolve selected statuses to ids.
  const needsCompliance = audience.conditions.some((c) => c.field === "complianceStatus");
  const complianceStatusByPerson = needsCompliance
    ? await loadComplianceStatusMap(activeTerm?.endDate ?? null)
    : undefined;

  const where = compilePersonWhere(audience, {
    activeTermId: activeTerm?.id ?? null,
    complianceStatusByPerson,
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
