import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createScope, updateScope, deleteScope, listScopes, getScope,
  grantScope, revokeScope, scopesForPerson, ScopeValidationError,
} from "./scopes";
import type { Audience } from "./types";

beforeEach(resetDb);

const ACTIVE_ONLY: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
};

describe("audience scopes", () => {
  it("creates, reads, updates and lists a scope", async () => {
    const s = await createScope(null, { name: "Peds", audience: ACTIVE_ONLY });
    expect(s.name).toBe("Peds");
    expect(s.audience).toEqual(ACTIVE_ONLY);

    await updateScope(null, s.id, { name: "Pediatrics", audience: ACTIVE_ONLY });
    expect((await getScope(s.id))?.name).toBe("Pediatrics");
    expect(await listScopes()).toHaveLength(1);
  });

  it("rejects a blank name and a malformed audience", async () => {
    await expect(
      createScope(null, { name: "  ", audience: ACTIVE_ONLY }),
    ).rejects.toBeInstanceOf(ScopeValidationError);
    await expect(
      createScope(null, { name: "X", audience: { bogus: true } as unknown as Audience }),
    ).rejects.toBeInstanceOf(ScopeValidationError);
  });

  it("refuses a sending identity on a domain the allowlist does not carry", async () => {
    // Refused at WRITE time, on both the create and the update path. Accepting
    // it would store an identity that no transport can DKIM-sign for, which
    // surfaces as a campaign failing after the sender has already hit Send --
    // by which point the run is claimed and every recipient is enqueued.
    await expect(
      createScope(null, { name: "Peds", audience: ACTIVE_ONLY, fromEmail: "peds@example.net" }),
    ).rejects.toBeInstanceOf(ScopeValidationError);
    expect(await listScopes()).toHaveLength(0);

    const s = await createScope(null, { name: "Peds", audience: ACTIVE_ONLY });
    await expect(
      updateScope(null, s.id, { name: "Peds", audience: ACTIVE_ONLY, fromEmail: "peds@example.net" }),
    ).rejects.toBeInstanceOf(ScopeValidationError);
    expect((await getScope(s.id))?.fromEmail).toBeNull();
  });

  it("stores a sending identity on an allowlisted domain, lowercased, and can clear it", async () => {
    const s = await createScope(null, {
      name: "Peds",
      audience: ACTIVE_ONLY,
      fromEmail: "  Peds@HavenFreeClinic.org ",
      fromName: " HAVEN Pediatrics ",
    });
    expect(s.fromEmail).toBe("peds@havenfreeclinic.org");
    expect(s.fromName).toBe("HAVEN Pediatrics");

    // A save that does not carry the fields at all must not blank them.
    await updateScope(null, s.id, { name: "Peds", audience: ACTIVE_ONLY });
    expect((await getScope(s.id))?.fromEmail).toBe("peds@havenfreeclinic.org");

    // An explicit empty string clears.
    await updateScope(null, s.id, { name: "Peds", audience: ACTIVE_ONLY, fromEmail: "", fromName: "" });
    expect((await getScope(s.id))?.fromEmail).toBeNull();
  });

  it("returns scopes granted directly to a person", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const s = await createScope(null, { name: "Direct", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { personId: p.id });

    const mine = await scopesForPerson(p.id);
    expect(mine.map((x) => x.name)).toEqual(["Direct"]);
  });

  it("returns scopes granted to a role the person holds", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const role = await prisma.role.create({ data: { name: "Lead" } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
    const s = await createScope(null, { name: "ViaRole", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { roleId: role.id });

    expect((await scopesForPerson(p.id)).map((x) => x.name)).toEqual(["ViaRole"]);
  });

  it("returns nothing for a person with no grants", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    await createScope(null, { name: "Unrelated", audience: ACTIVE_ONLY });
    expect(await scopesForPerson(p.id)).toEqual([]);
  });

  it("deduplicates a scope granted both directly and via a role", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const role = await prisma.role.create({ data: { name: "Lead" } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
    const s = await createScope(null, { name: "Both", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { personId: p.id });
    await grantScope(null, s.id, { roleId: role.id });

    expect(await scopesForPerson(p.id)).toHaveLength(1);
  });

  it("revokes a grant", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const s = await createScope(null, { name: "Temp", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { personId: p.id });
    const grant = await prisma.audienceScopeGrant.findFirstOrThrow({ where: { scopeId: s.id } });

    await revokeScope(null, grant.id);
    expect(await scopesForPerson(p.id)).toEqual([]);
  });

  it("refuses to delete a scope a campaign still references", async () => {
    const s = await createScope(null, { name: "InUse", audience: ACTIVE_ONLY });
    await prisma.emailCampaign.create({
      data: {
        name: "C",
        scopeId: s.id,
        audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] },
      },
    });
    await expect(deleteScope(null, s.id)).rejects.toBeInstanceOf(ScopeValidationError);
  });

  it("falls back to a match-nobody audience when the stored JSON is corrupt", async () => {
    const row = await prisma.audienceScope.create({
      data: { name: "Corrupt", audienceJson: { bogus: true } },
    });
    const view = await getScope(row.id);
    expect(view?.audience).toEqual({ recordType: "PERSON", match: "ALL", conditions: [] });
  });
});
