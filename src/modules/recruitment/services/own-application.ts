import { prisma } from "@/platform/db";
import { yaleEmailForNetId } from "@/platform/auth/match-person";
import type { ReviewerIdentity } from "../engine/own-application";

/** Who these people are, for recognising their own applications (see
 *  engine/own-application.ts). One query however many are asked for; a person
 *  who does not exist is simply absent. */
export async function reviewerIdentities(personIds: string[]): Promise<ReviewerIdentity[]> {
  if (personIds.length === 0) return [];
  const people = await prisma.person.findMany({
    where: { id: { in: personIds } },
    select: { id: true, netId: true, contactEmail: true },
  });
  return people.map((p) => {
    const netId = p.netId?.trim().toLowerCase() || null;
    const emails = [p.contactEmail?.trim().toLowerCase(), netId ? yaleEmailForNetId(netId) : null].filter(
      (e): e is string => Boolean(e),
    );
    return { personId: p.id, netId, emails };
  });
}

export async function reviewerIdentity(personId: string): Promise<ReviewerIdentity> {
  return (await reviewerIdentities([personId]))[0] ?? { personId, netId: null, emails: [] };
}
