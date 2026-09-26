import { prisma } from "@/platform/db";

/** One connected app as the Connected apps page lists it. */
export type ConnectionRow = {
  id: string;
  personId: string;
  personName: string;
  /** The app's own name when it gave one (unverified), else where it identified itself from. */
  appLabel: string;
  resource: string;
  scope: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/**
 * A connection is listed while it is not revoked AND still holds a refresh
 * token that could be used. Without the second half, a connection whose tokens
 * all lapsed a month ago would sit on the page looking live forever, and a
 * person could not tell which of their connectors still works.
 */
function liveWhere(now: Date) {
  return {
    revokedAt: null,
    tokens: { some: { kind: "REFRESH" as const, usedAt: null, expiresAt: { gt: now } } },
  };
}

async function rows(where: object): Promise<ConnectionRow[]> {
  const found = await prisma.oAuthConnection.findMany({
    where,
    include: { person: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return found.map((c) => ({
    id: c.id,
    personId: c.personId,
    personName: c.person.name,
    appLabel: c.clientName ?? (c.clientId.startsWith("https://") ? hostOf(c.clientId) : "Unnamed app"),
    resource: c.resource,
    scope: c.scope,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
  }));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function listMyConnections(personId: string, now: Date = new Date()): Promise<ConnectionRow[]> {
  return rows({ personId, ...liveWhere(now) });
}

export function listAllConnections(now: Date = new Date()): Promise<ConnectionRow[]> {
  return rows(liveWhere(now));
}

export async function connectionOwner(connectionId: string): Promise<string | null> {
  const c = await prisma.oAuthConnection.findUnique({ where: { id: connectionId }, select: { personId: true } });
  return c?.personId ?? null;
}
