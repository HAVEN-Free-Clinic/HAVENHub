/**
 * Personal calendar-feed credentials.
 *
 * The token is stored in plaintext by design. A calendar subscription URL has
 * to stay re-readable so a member can add it on a second device months later,
 * and a hash cannot be reversed. The feed carries shift dates only, no patient
 * data, and rotation is one click.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/platform/db";

/** Minimum gap between lastFetchedAt writes. Bounds write volume on a public endpoint. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Create or replace this person's feed token and return it. */
export async function issueFeedToken(personId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.calendarFeedToken.upsert({
    where: { personId },
    create: { personId, token },
    // Rotation: overwrite in place and clear the fetch history so the card does
    // not report a fetch that belonged to the previous URL.
    update: { token, lastFetchedAt: null, createdAt: new Date() },
  });
  return token;
}

/** Resolve a raw token to its owner, or null when it does not exist. */
export async function resolveFeedToken(token: string): Promise<{ personId: string } | null> {
  return prisma.calendarFeedToken.findUnique({
    where: { token },
    select: { personId: true },
  });
}

/** The person's current feed token and fetch history, for the My Info card. */
export async function readFeedToken(
  personId: string,
): Promise<{ token: string; lastFetchedAt: Date | null } | null> {
  return prisma.calendarFeedToken.findUnique({
    where: { personId },
    select: { token: true, lastFetchedAt: true },
  });
}

/** Record a fetch, at most once per hour. */
export async function touchFeedToken(personId: string, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - TOUCH_INTERVAL_MS);
  await prisma.calendarFeedToken.updateMany({
    // Explicit OR on null: Prisma's `not` filter drops NULL rows, so a
    // never-fetched token would never record its very first fetch.
    where: { personId, OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: cutoff } }] },
    data: { lastFetchedAt: now },
  });
}
