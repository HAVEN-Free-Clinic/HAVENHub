import { prisma } from "@/platform/db";
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
  const activeTerm = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  const where = compilePersonWhere(audience, { activeTermId: activeTerm?.id ?? null });
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
