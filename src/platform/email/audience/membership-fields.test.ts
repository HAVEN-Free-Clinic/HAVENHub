import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";

beforeEach(resetDb);

async function person(name: string, email: string | null) {
  return prisma.person.create({ data: { name, contactEmail: email, status: "ACTIVE" } });
}

async function languageRow(
  personId: string,
  language: string,
  opts: { selfReported?: boolean; verified?: boolean; verifiedAt?: Date | null } = {},
) {
  return prisma.personLanguage.create({
    data: {
      personId,
      language,
      selfReported: opts.selfReported ?? false,
      verified: opts.verified ?? false,
      verifiedAt: opts.verifiedAt ?? null,
    },
  });
}

describe("resolveAudience speaksLanguage", () => {
  it("matches a person verified in the selected language", async () => {
    const p = await person("Verified Speaker", "verified@example.com");
    await languageRow(p.id, "es", { verified: true, verifiedAt: new Date() });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "speaksLanguage", op: "in", value: ["es"] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["verified@example.com"]);
  });

  // The trap this task is built around: verified: false WITH verifiedAt set
  // means "a human assessed this person and they did not pass", not "unknown".
  // Reading `verified` without `verifiedAt` -- or worse, treating any row as a
  // pass -- would let a failed assessment through.
  it("does NOT match a person assessed and FAILED (verified: false, verifiedAt set)", async () => {
    const p = await person("Failed Assessment", "failed@example.com");
    await languageRow(p.id, "es", { verified: false, verifiedAt: new Date() });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "speaksLanguage", op: "in", value: ["es"] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("does NOT match a self-reported-only claim (claim, not qualification)", async () => {
    const p = await person("Self Reported Only", "claimed@example.com");
    await languageRow(p.id, "es", { selfReported: true });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "speaksLanguage", op: "in", value: ["es"] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("notIn excludes the verified speaker but keeps everyone else, including people with no language row at all", async () => {
    const speaker = await person("Verified Speaker", "speaker@example.com");
    await languageRow(speaker.id, "es", { verified: true, verifiedAt: new Date() });
    await person("No Language Row", "none@example.com");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "speaksLanguage", op: "notIn", value: ["es"] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["none@example.com"]);
  });
});

describe("resolveAudience claimsLanguage", () => {
  it("matches a self-reported claim regardless of verification", async () => {
    const p = await person("Claimant", "claimant@example.com");
    await languageRow(p.id, "fr", { selfReported: true });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "claimsLanguage", op: "in", value: ["fr"] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["claimant@example.com"]);
  });

  it("does NOT match a person verified but who never self-reported the claim", async () => {
    const p = await person("Assessed Not Claimed", "assessed@example.com");
    await languageRow(p.id, "fr", { verified: true, verifiedAt: new Date(), selfReported: false });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "claimsLanguage", op: "in", value: ["fr"] }],
    });
    expect(res.recipients).toEqual([]);
  });
});

describe("resolveAudience hasServiceCredential", () => {
  it("matches a person who has a service credential", async () => {
    const p = await person("Credentialed", "credentialed@example.com");
    await prisma.serviceCredential.create({
      data: { personId: p.id, record: { terms: [] } },
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hasServiceCredential", op: "isTrue" }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["credentialed@example.com"]);
  });

  it("does NOT match a person with no service credential", async () => {
    await person("No Credential", "nocred@example.com");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hasServiceCredential", op: "isTrue" }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("isFalse matches the person with no service credential, not the credentialed one", async () => {
    const credentialed = await person("Credentialed", "credentialed2@example.com");
    await prisma.serviceCredential.create({
      data: { personId: credentialed.id, record: { terms: [] } },
    });
    await person("No Credential", "nocred2@example.com");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hasServiceCredential", op: "isFalse" }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["nocred2@example.com"]);
  });

  // The trap this fix is built around: a credential revoked for falsified
  // service (ServiceCredential.revokedAt set) is not a valid credential.
  // revokedAt is the SOLE invalidating signal everywhere else it is read (see
  // src/modules/passport/services/credential.ts), so "has a service
  // credential" must mean "has one that is not revoked" -- and the negative
  // branch must catch BOTH a revoked credential AND no credential row at all,
  // since Person.serviceCredential is a nullable one-to-one.
  it("isTrue matches only the active credential, not the revoked one or the person with none", async () => {
    const active = await person("Active Credential", "active-cred@example.com");
    await prisma.serviceCredential.create({
      data: { personId: active.id, record: { terms: [] } },
    });

    const revoked = await person("Revoked Credential", "revoked-cred@example.com");
    await prisma.serviceCredential.create({
      data: { personId: revoked.id, record: { terms: [] }, revokedAt: new Date() },
    });

    await person("No Credential", "no-cred@example.com");

    const isTrue = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hasServiceCredential", op: "isTrue" }],
    });
    expect(isTrue.recipients.map((r) => r.email)).toEqual(["active-cred@example.com"]);

    const isFalse = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hasServiceCredential", op: "isFalse" }],
    });
    expect(isFalse.recipients.map((r) => r.email).sort()).toEqual([
      "no-cred@example.com",
      "revoked-cred@example.com",
    ]);
  });
});
