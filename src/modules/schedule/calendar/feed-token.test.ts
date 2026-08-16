import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { issueFeedToken, resolveFeedToken, readFeedToken, touchFeedToken } from "./feed-token";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

function makePerson() {
  return prisma.person.create({ data: { name: "Ada Lovelace", status: "ACTIVE" } });
}

describe("feed tokens", () => {
  it("issues a token that resolves back to the person", async () => {
    const person = await makePerson();
    const token = await issueFeedToken(person.id);

    expect(token.length).toBeGreaterThan(30);
    expect(await resolveFeedToken(token)).toEqual({ personId: person.id });
  });

  it("keeps exactly one row per person and invalidates the old token on reissue", async () => {
    const person = await makePerson();
    const first = await issueFeedToken(person.id);
    const second = await issueFeedToken(person.id);

    expect(second).not.toBe(first);
    expect(await prisma.calendarFeedToken.count({ where: { personId: person.id } })).toBe(1);
    expect(await resolveFeedToken(first)).toBeNull();
    expect(await resolveFeedToken(second)).toEqual({ personId: person.id });
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveFeedToken("not-a-real-token")).toBeNull();
  });

  it("reads back the stored token for display", async () => {
    const person = await makePerson();
    const token = await issueFeedToken(person.id);

    expect(await readFeedToken(person.id)).toEqual({ token, lastFetchedAt: null });
  });

  it("returns null when the person has never generated a feed", async () => {
    const person = await makePerson();
    expect(await readFeedToken(person.id)).toBeNull();
  });

  // Regression: a never-fetched token has lastFetchedAt NULL. A `{ not: cutoff }`
  // style filter would silently drop that row and the first fetch would never record.
  it("records the first fetch on a never-fetched token", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    const now = new Date("2026-08-06T12:00:00Z");
    await touchFeedToken(person.id, now);

    expect((await readFeedToken(person.id))?.lastFetchedAt).toEqual(now);
  });

  it("does not rewrite lastFetchedAt within the hour", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    const first = new Date("2026-08-06T12:00:00Z");
    await touchFeedToken(person.id, first);
    await touchFeedToken(person.id, new Date("2026-08-06T12:30:00Z"));

    expect((await readFeedToken(person.id))?.lastFetchedAt).toEqual(first);
  });

  it("rewrites lastFetchedAt once an hour has passed", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    await touchFeedToken(person.id, new Date("2026-08-06T12:00:00Z"));
    const later = new Date("2026-08-06T13:30:00Z");
    await touchFeedToken(person.id, later);

    expect((await readFeedToken(person.id))?.lastFetchedAt).toEqual(later);
  });

  it("drops the feed when the person is deleted", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    await prisma.person.delete({ where: { id: person.id } });

    expect(await prisma.calendarFeedToken.count()).toBe(0);
  });
});
