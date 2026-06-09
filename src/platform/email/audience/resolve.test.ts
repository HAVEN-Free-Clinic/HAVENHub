import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";

beforeEach(resetDb);

async function person(name: string, email: string | null, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, contactEmail: email, status } });
}

describe("resolveAudience (PERSON)", () => {
  it("returns recipients matching the where and excludes blank emails", async () => {
    await person("Active One", "one@example.com", "ACTIVE");
    await person("Active NoEmail", null, "ACTIVE");
    await person("Offboarded", "off@example.com", "OFFBOARDED");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
    });

    expect(res.recipients.map((r) => r.email).sort()).toEqual(["one@example.com"]);
    expect(res.excludedNoEmail).toBe(1);
    expect(res.recipients[0].variables).toEqual({ firstName: "Active", name: "Active One" });
    expect(res.recipients[0].recordType).toBe("PERSON");
  });

  it("empty conditions resolve to zero recipients", async () => {
    await person("Someone", "s@example.com");
    const res = await resolveAudience({ recordType: "PERSON", match: "ALL", conditions: [] });
    expect(res.recipients).toEqual([]);
  });
});
