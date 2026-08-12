import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { recordLoginContext } from "./login-record";

/** Minimal stand-in for Headers, matching the one method this needs. */
function headerBag(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

async function makePerson() {
  return prisma.person.create({ data: { name: "Test Person" } });
}

describe("recordLoginContext", () => {
  beforeEach(resetDb);

  it("records the timestamp, user agent, city, and country", async () => {
    const person = await makePerson();

    await recordLoginContext(
      person.id,
      headerBag({
        "user-agent": "Mozilla/5.0 (Macintosh) Chrome/131.0.0.0",
        "x-vercel-ip-city": "New Haven",
        "x-vercel-ip-country": "US",
      })
    );

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginAt).toBeInstanceOf(Date);
    expect(updated.lastLoginUserAgent).toBe("Mozilla/5.0 (Macintosh) Chrome/131.0.0.0");
    expect(updated.lastLoginCity).toBe("New Haven");
    expect(updated.lastLoginCountry).toBe("US");
  });

  // Vercel percent-encodes the city, so storing it raw would show an admin
  // "New%20Haven".
  it("decodes a percent-encoded city", async () => {
    const person = await makePerson();

    await recordLoginContext(
      person.id,
      headerBag({ "x-vercel-ip-city": "New%20Haven", "x-vercel-ip-country": "US" })
    );

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginCity).toBe("New Haven");
  });

  // Local development has no Vercel edge, so every geo header is absent. That is
  // the normal shape in dev, not a failure.
  it("writes null for absent headers, and still stamps the time", async () => {
    const person = await makePerson();

    await recordLoginContext(person.id, headerBag({}));

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginAt).toBeInstanceOf(Date);
    expect(updated.lastLoginUserAgent).toBeNull();
    expect(updated.lastLoginCity).toBeNull();
    expect(updated.lastLoginCountry).toBeNull();
  });

  // A bare "%" makes decodeURIComponent throw. A login is not worth losing over
  // a city name, so the raw value stands.
  it("keeps the raw city when it cannot be decoded", async () => {
    const person = await makePerson();

    await recordLoginContext(person.id, headerBag({ "x-vercel-ip-city": "100%" }));

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(updated.lastLoginCity).toBe("100%");
  });

  // THE contract that matters: nothing here may ever break a sign-in. A
  // volunteer locked out because a geo header was malformed, or because Neon
  // blinked, would be far worse than a missing timestamp.
  it("swallows a database failure instead of throwing into the login path", async () => {
    const spy = vi
      .spyOn(prisma.person, "update")
      .mockRejectedValueOnce(new Error("database is on fire"));

    await expect(recordLoginContext("some-person-id", headerBag({}))).resolves.toBeUndefined();

    spy.mockRestore();
  });

  it("swallows a throwing header bag instead of throwing into the login path", async () => {
    const exploding = {
      get: () => {
        throw new Error("headers unavailable");
      },
    };

    await expect(recordLoginContext("some-person-id", exploding)).resolves.toBeUndefined();
  });
});
