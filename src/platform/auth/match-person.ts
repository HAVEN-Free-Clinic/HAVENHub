import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";

export type LoginProfile = {
  entraObjectId?: string | null;
  upn?: string | null;
  email?: string | null;
};

/**
 * Yale UPNs look like "abc123@yale.edu" (NetID local part).
 * Alias addresses ("first.last@yale.edu") are not NetIDs.
 */
export function netIdFromUpn(upn: string): string | null {
  const local = upn.split("@")[0] ?? "";
  return /^[a-z]{2,8}[0-9]*$/i.test(local) ? local.toLowerCase() : null;
}

/** Resolution order per spec §5. Matches via steps 2/3 link entraObjectId. */
export async function resolvePersonForLogin(
  profile: LoginProfile
): Promise<Person | null> {
  // 1. Already linked
  if (profile.entraObjectId) {
    const linked = await prisma.person.findUnique({
      where: { entraObjectId: profile.entraObjectId },
    });
    if (linked) return linked;
  }

  // 2. NetID extracted from UPN
  const netId = profile.upn ? netIdFromUpn(profile.upn) : null;
  if (netId) {
    const byNetId = await prisma.person.findFirst({
      where: { netId: { equals: netId, mode: "insensitive" } },
    });
    if (byNetId) return link(byNetId, profile.entraObjectId);
  }

  // 3. Email against contactEmail or yaleEmail
  if (profile.email) {
    const byEmail = await prisma.person.findFirst({
      where: {
        OR: [
          { contactEmail: { equals: profile.email, mode: "insensitive" } },
          { yaleEmail: { equals: profile.email, mode: "insensitive" } },
        ],
      },
    });
    if (byEmail) return link(byEmail, profile.entraObjectId);
  }

  // 4. No match
  return null;
}

async function link(person: Person, entraObjectId?: string | null): Promise<Person> {
  if (!entraObjectId || person.entraObjectId === entraObjectId) return person;
  return prisma.person.update({
    where: { id: person.id },
    data: { entraObjectId },
  });
}
