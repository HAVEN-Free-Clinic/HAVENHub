/**
 * Sender identity: WHO may send as WHAT.
 *
 * The authorization cases come first and deliberately so. Resolution order is a
 * correctness property; the authorization boundary is the reason this module
 * exists at all, because a delegated sender who can put an arbitrary address in
 * the From makes the whole delegation model worthless.
 *
 * Every malicious address used below is on an ALLOWLISTED domain. That is the
 * single most important thing about these tests: an address on some unlisted
 * domain would be refused by the allowlist check alone, so a test using one
 * would pass against an implementation that had no per-person authorization at
 * all. Each of these has to be refused by the ownership check specifically.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ALLOWLIST THIS FILE VALIDATES AGAINST, stated here rather than borrowed.
 *
 * Almost every test below only needs a domain to BE on the allowlist, and the
 * two real ones are what the fixtures have always used. They stay, and stay
 * Maileroo-signed, which is what production says today.
 *
 * The third row is the point. One test asserts that issueSendingIdentity records
 * whatever transport the allowlist gives an address, and that only means
 * something if the allowlist can give two different answers. It used to get its
 * second answer from yale.edu, which was Graph-signed until Maileroo verified it
 * on 2026-09-02. With the shipped table now answering "maileroo" for everything,
 * a test written against it could no longer tell "reads the allowlist" from
 * "returns maileroo". So the Graph polarity comes from a domain declared here,
 * for that purpose, on the RFC 2606 reserved `.example` TLD so it can never
 * quietly start meaning something about a real sending domain.
 *
 * Set through SENDING_DOMAINS, the same override an operator pulls, so the real
 * chain underneath still runs: config.ts's format check, parseSendingDomains,
 * and the module-level map signingTransportFor reads. vitest.setup.ts re-claims
 * the variable before every test file, so this cannot leak into one that expects
 * the shipped default.
 */
const { GRAPH_SIGNED_ADDRESS } = vi.hoisted(() => {
  const GRAPH_SIGNED_DOMAIN = "graph-signed.example";
  process.env.SENDING_DOMAINS = [
    "havenfreeclinic.org:maileroo",
    "yale.edu:maileroo",
    `${GRAPH_SIGNED_DOMAIN}:graph`,
  ].join(",");
  return { GRAPH_SIGNED_ADDRESS: `dean@${GRAPH_SIGNED_DOMAIN}` };
});

import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  SenderIdentityError,
  availableSenderIdentities,
  issueSendingIdentity,
  listIssuedIdentities,
  resolveSenderIdentity,
  revokeSendingIdentity,
  revokeSendingIdentityGrant,
} from "./sender-identity";

beforeEach(resetDb);

/** A scope's identity, in the shape resolveSenderIdentity takes one. */
function scopeIdentity(fromEmail: string | null, fromName: string | null = null) {
  return { fromEmail, fromName };
}

async function person(name: string, contactEmail: string | null) {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
}

/**
 * A role, with people assigned to it person-target and term-global.
 *
 * termId: null on purpose, matching scopes.test.ts: these cases are about the
 * identity a role confers, not about term scoping, and a term-scoped assignment
 * would need an ACTIVE term fixture that has nothing to do with what is being
 * asserted. roleIdsForPerson resolves a global person-targeted assignment with
 * no term at all, which is what makes that possible.
 */
async function role(name: string, members: Array<{ id: string }>) {
  const created = await prisma.role.create({ data: { name } });
  for (const m of members) {
    await prisma.roleAssignment.create({
      data: { roleId: created.id, personId: m.id, termId: null },
    });
  }
  return created;
}

// ---------------------------------------------------------------------------
// Authorization. First, and the whole point of the module.
// ---------------------------------------------------------------------------

describe("authorization: a scoped sender cannot send as an arbitrary address", () => {
  it("refuses an address that is neither issued, nor theirs, nor their scope's", async () => {
    // The request a malicious scoped sender actually makes. They hold
    // outreach.send and a grant on one scope, so they can legitimately open the
    // campaign editor and POST its compose form. The dropdown offers them two
    // addresses; they submit a third by hand:
    //
    //   POST /outreach/campaigns/<their campaign>
    //   name=Newsletter&subject=...&body=...&fromEmail=dean%40yale.edu
    //
    // dean@yale.edu is on yale.edu, which SENDING_DOMAINS carries, so the
    // allowlist check passes and only the ownership check can stop it.
    const sender = await person("Scoped Sender", "sender@yale.edu");
    await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });

    await expect(
      resolveSenderIdentity(sender.id, scopeIdentity("peds@havenfreeclinic.org"), "dean@yale.edu"),
    ).rejects.toBeInstanceOf(SenderIdentityError);

    // And the same address issued to somebody ELSE is still not theirs: an
    // implementation that asked "is this address issued at all" rather than
    // "is it issued to this person" would pass the case above and fail here.
    const colleague = await person("Colleague", "colleague@yale.edu");
    await issueSendingIdentity(null, { personId: colleague.id, address: "dean@yale.edu" });
    await expect(
      resolveSenderIdentity(sender.id, scopeIdentity("peds@havenfreeclinic.org"), "dean@yale.edu"),
    ).rejects.toBeInstanceOf(SenderIdentityError);

    // Nor is somebody else's contactEmail theirs.
    await expect(
      resolveSenderIdentity(sender.id, scopeIdentity(null), "colleague@yale.edu"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
  });

  it("refuses ANOTHER scope's identity, not merely any unknown address", async () => {
    // The subtler crafted request: the sender names a real, admin-configured
    // identity -- just not the one belonging to the scope their campaign is
    // bound to. Authorization is per campaign scope, not "is this an identity
    // some scope somewhere uses".
    const sender = await person("Scoped Sender", "sender@yale.edu");
    await prisma.audienceScope.create({
      data: {
        name: "Executive",
        audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] },
        fromEmail: "exec@havenfreeclinic.org",
      },
    });

    await expect(
      resolveSenderIdentity(
        sender.id,
        scopeIdentity("peds@havenfreeclinic.org"),
        "exec@havenfreeclinic.org",
      ),
    ).rejects.toBeInstanceOf(SenderIdentityError);
  });

  it("is not fooled by case or surrounding whitespace either way", async () => {
    const sender = await person("Scoped Sender", "sender@yale.edu");
    await issueSendingIdentity(null, {
      personId: sender.id,
      address: "Recruitment@HavenFreeClinic.org",
    });

    // Granted: the stored form is lowercased, and a differently-cased request
    // still matches it, so case cannot be used to slip past the check.
    const ok = await resolveSenderIdentity(
      sender.id,
      scopeIdentity(null),
      "  RECRUITMENT@havenfreeclinic.ORG ",
    );
    expect(ok?.address).toBe("recruitment@havenfreeclinic.org");

    // Refused: case does not turn an address they do not hold into one they do.
    await expect(
      resolveSenderIdentity(sender.id, scopeIdentity(null), "DEAN@Yale.edu"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
  });

  it("gives a sender with no claims at all nothing to send as", async () => {
    // No scope identity, nothing issued, and a contactEmail on a domain the
    // allowlist does not carry. The default is null (fall through to the global
    // sender) and every explicit request is refused.
    const sender = await person("Outsider", "someone@gmail.com");
    expect(await availableSenderIdentities(sender.id, null)).toEqual([]);
    expect(await resolveSenderIdentity(sender.id, null, null)).toBeNull();
    await expect(
      resolveSenderIdentity(sender.id, null, "someone@gmail.com"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
    // On an ALLOWLISTED domain, so this refusal is the ownership check doing the
    // work and not the domain check. Without it this case would still pass
    // against an implementation with no ownership check at all, which is exactly
    // the vacuous-test shape these tests exist to avoid.
    await expect(
      resolveSenderIdentity(sender.id, null, "dean@yale.edu"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
  });

  it("refuses an address the sender merely typed into their own profile", async () => {
    // The reason Person.contactEmail is NOT a claim. It is self-service,
    // unverified free text (/my-info writes it), so treating it as proof of
    // anything reduces the check to "is it the value I just typed". The
    // allowlist cannot save this: it is domain-level and cannot tell sender@
    // from directors@, and havenfreeclinic.org is Maileroo-signed, so an address
    // on it leaves AS ITSELF, DKIM-aligned, under DMARC p=reject. There is no
    // Send-As brake the way there is for yale.edu.
    //
    // Reproduced end to end before this was closed: a person holding only
    // outreach.send plus one scope grant set their profile to
    // directors@havenfreeclinic.org, and the campaign enqueued from it.
    const sender = await person("Scoped Sender", "directors@havenfreeclinic.org");

    // Not offered, so the picker cannot present it as legitimate...
    expect(await availableSenderIdentities(sender.id, null)).toEqual([]);
    // ...and not accepted either, which is the half that matters, since the
    // picker is only a menu and the POST is what gets authorized.
    await expect(
      resolveSenderIdentity(sender.id, null, "directors@havenfreeclinic.org"),
    ).rejects.toBeInstanceOf(SenderIdentityError);

    // Nor does an admin-set scope identity make the typed one legitimate by
    // sitting beside it: every layer used to be appended to ONE option list, so
    // a scope identity did not displace the profile address, it accompanied it.
    expect(
      (await availableSenderIdentities(sender.id, scopeIdentity("peds@havenfreeclinic.org"))).map(
        (o) => o.address,
      ),
    ).toEqual(["peds@havenfreeclinic.org"]);
    await expect(
      resolveSenderIdentity(
        sender.id,
        scopeIdentity("peds@havenfreeclinic.org"),
        "directors@havenfreeclinic.org",
      ),
    ).rejects.toBeInstanceOf(SenderIdentityError);

    // Issuing that same address is how it becomes legitimate: an admin acts.
    await issueSendingIdentity(null, {
      personId: sender.id,
      address: "directors@havenfreeclinic.org",
    });
    expect(
      (await resolveSenderIdentity(sender.id, null, "directors@havenfreeclinic.org"))?.source,
    ).toBe("issued");
  });
});

describe("authorization: revocation", () => {
  it("does not resolve a REVOKED issued identity", async () => {
    const sender = await person("Scoped Sender", "sender@yale.edu");
    const issued = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
    });

    // Held while it is live.
    expect(
      (await resolveSenderIdentity(sender.id, null, "recruitment@havenfreeclinic.org"))?.source,
    ).toBe("issued");

    await revokeSendingIdentity(null, issued.id);

    // The row is still THERE. That is the point: revocation flips revokedAt on
    // the same row rather than deleting it, so a presence-only check --
    // `findFirst({ where: { personId, address } })`, which is the exact bug
    // ServiceCredential shipped -- would still find it and count it as valid.
    // Assert the row's continued existence explicitly so this test cannot be
    // satisfied by an implementation that simply deletes on revoke.
    const row = await prisma.sendingIdentity.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.revokedAt).not.toBeNull();

    await expect(
      resolveSenderIdentity(sender.id, null, "recruitment@havenfreeclinic.org"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
    // Nothing is left: revoking the only issued address leaves this person with
    // no claim at all, because their profile address is not one.
    expect(await availableSenderIdentities(sender.id, null)).toEqual([]);
  });

  it("re-issues in place rather than creating a second row", async () => {
    // The uniqueness constraint is the ADDRESS since Task 3, so a
    // revoke-then-reissue has to clear revokedAt on the row that is already
    // there. A second insert would violate the constraint outright.
    const sender = await person("Scoped Sender", "sender@yale.edu");
    const first = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await revokeSendingIdentity(null, first.id);

    // A DIFFERENT holder, to pin the other half of the restore rule: re-issuing
    // un-retires the address (an admin just named it), but does not resurrect
    // the holders whose grants were removed while it was retired.
    const other = await person("Other", "other@yale.edu");
    const again = await issueSendingIdentity(null, {
      personId: other.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "Back Again",
    });
    expect(again.id).toBe(first.id);
    expect(again.revokedAt).toBeNull();
    expect(again.displayName).toBe("Back Again");
    expect(await prisma.sendingIdentity.count()).toBe(1);

    expect(
      (await resolveSenderIdentity(other.id, null, "recruitment@havenfreeclinic.org"))?.source,
    ).toBe("issued");
  });

  it("removing one holder's grant leaves the shared address live for the other", async () => {
    // Two revocations, and this is the narrow one. A shared mailbox is one row
    // now, held by many grants, so taking it away from one person is a delete of
    // THEIR grant -- and must not touch anybody else's route to it.
    const alice = await person("Alice", "alice@yale.edu");
    const bob = await person("Bob", "bob@yale.edu");
    const identity = await issueSendingIdentity(null, {
      personId: alice.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      personId: bob.id,
      address: "recruitment@havenfreeclinic.org",
    });
    expect(identity.grants).toHaveLength(1);

    const hers = await prisma.sendingIdentityGrant.findFirstOrThrow({
      where: { identityId: identity.id, personId: alice.id },
    });
    await revokeSendingIdentityGrant(null, hers.id);

    await expect(
      resolveSenderIdentity(alice.id, null, "recruitment@havenfreeclinic.org"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
    expect(
      (await resolveSenderIdentity(bob.id, null, "recruitment@havenfreeclinic.org"))?.address,
    ).toBe("recruitment@havenfreeclinic.org");
    // And the address itself is untouched: this revocation is not the retiring
    // kind, so nothing about it is marked.
    const row = await prisma.sendingIdentity.findUniqueOrThrow({ where: { id: identity.id } });
    expect(row.revokedAt).toBeNull();
  });

  it("retiring the address kills EVERY route to it, direct and role alike", async () => {
    // The wide revocation, and the reason revokedAt lives on the identity rather
    // than on the grants. Three routes to one address: Alice holds it directly,
    // Bob holds it through a role, and Carol holds it through a SECOND role.
    // One flip has to close all three at once -- and the grants stay in the
    // table, so an implementation that filtered presence-of-grant rather than
    // the flag would still find every one of them.
    const alice = await person("Alice", "alice@yale.edu");
    const bob = await person("Bob", "bob@yale.edu");
    const carol = await person("Carol", "carol@yale.edu");
    const editors = await role("Editors", [bob]);
    const chairs = await role("Chairs", [carol]);

    const identity = await issueSendingIdentity(null, {
      personId: alice.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      roleId: chairs.id,
      address: "recruitment@havenfreeclinic.org",
    });

    for (const p of [alice, bob, carol]) {
      expect(
        (await resolveSenderIdentity(p.id, null, "recruitment@havenfreeclinic.org"))?.source,
      ).toBe("issued");
    }

    await revokeSendingIdentity(null, identity.id);

    // All three grants are STILL THERE. That is the point: a presence-only
    // lookup -- the exact bug ServiceCredential shipped -- would still find one
    // for each of them and count it as valid.
    expect(await prisma.sendingIdentityGrant.count({ where: { identityId: identity.id } })).toBe(3);
    const row = await prisma.sendingIdentity.findUniqueOrThrow({ where: { id: identity.id } });
    expect(row.revokedAt).not.toBeNull();

    for (const p of [alice, bob, carol]) {
      await expect(
        resolveSenderIdentity(p.id, null, "recruitment@havenfreeclinic.org"),
      ).rejects.toBeInstanceOf(SenderIdentityError);
      expect(await availableSenderIdentities(p.id, null)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Role grants. The Task 3 request: identities assignable by role, like scopes.
// ---------------------------------------------------------------------------

describe("authorization: role grants", () => {
  it("resolves for a person holding the role, and for nobody else", async () => {
    const holder = await person("Holder", "holder@yale.edu");
    const outsider = await person("Outsider", "outsider@yale.edu");
    const editors = await role("Editors", [holder]);

    await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
    });

    expect(await availableSenderIdentities(holder.id, null)).toMatchObject([
      { address: "recruitment@havenfreeclinic.org", displayName: "HAVEN Recruitment", source: "issued" },
    ]);
    // The outsider is a real, ACTIVE person with no assignment to that role. An
    // implementation that expanded roles too broadly -- "any role that exists",
    // or one that ignored the assignment target -- would hand them the clinic's
    // recruitment address.
    expect(await availableSenderIdentities(outsider.id, null)).toEqual([]);
    await expect(
      resolveSenderIdentity(outsider.id, null, "recruitment@havenfreeclinic.org"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
  });

  it("takes the identity away the moment the role is removed, with no save in between", async () => {
    // No refresh, no re-save, no invalidation step: the two calls below are the
    // same call, either side of a DELETE on the assignment. availableSenderIdentities
    // expands roles live through roleIdsForPerson, so there is nothing to go
    // stale -- which is the property that makes a role grant safe to offer at all.
    const holder = await person("Holder", "holder@yale.edu");
    const editors = await role("Editors", [holder]);
    await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
    });

    expect(
      (await resolveSenderIdentity(holder.id, null, "recruitment@havenfreeclinic.org"))?.address,
    ).toBe("recruitment@havenfreeclinic.org");

    await prisma.roleAssignment.deleteMany({ where: { roleId: editors.id, personId: holder.id } });

    expect(await availableSenderIdentities(holder.id, null)).toEqual([]);
    await expect(
      resolveSenderIdentity(holder.id, null, "recruitment@havenfreeclinic.org"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
    // The grant itself is untouched: it is the ROLE that stopped reaching them.
    // Anyone else in the role still has it, which is the whole point of granting
    // to a role rather than to a list of people.
    const stillThere = await person("Successor", "successor@yale.edu");
    await prisma.roleAssignment.create({ data: { roleId: editors.id, personId: stillThere.id } });
    expect(
      (await resolveSenderIdentity(stillThere.id, null, "recruitment@havenfreeclinic.org"))?.address,
    ).toBe("recruitment@havenfreeclinic.org");
  });

  it("offers one address once when both a direct grant and a role reach it", async () => {
    const holder = await person("Holder", "holder@yale.edu");
    const editors = await role("Editors", [holder]);
    await issueSendingIdentity(null, {
      personId: holder.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
    });

    // One identity row, two grants, one option. A join that fanned out per grant
    // would offer the same address twice, and the picker would show a duplicate.
    expect(await prisma.sendingIdentity.count()).toBe(1);
    expect(await prisma.sendingIdentityGrant.count()).toBe(2);
    expect(await availableSenderIdentities(holder.id, null)).toHaveLength(1);

    // And losing the role does NOT take it away, because the direct grant still
    // reaches them. The routes are independent.
    await prisma.roleAssignment.deleteMany({ where: { roleId: editors.id, personId: holder.id } });
    expect(await availableSenderIdentities(holder.id, null)).toHaveLength(1);
  });

  it("adding a second holder does not erase the address's display name", async () => {
    // Found by driving the page, not by any test that existed at the time. The
    // display name is a property of the ADDRESS now, and this same form is how a
    // second holder gets added, so an unconditional write made "add the Director
    // role to recruitment@" silently blank the From that recipients had been
    // seeing -- the blank optional field reading as "erase it".
    const holder = await person("Holder", "holder@yale.edu");
    const editors = await role("Editors", []);
    await issueSendingIdentity(null, {
      personId: holder.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
    });

    const after = await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
      // No displayName, exactly as the form submits it when the admin leaves the
      // optional field alone.
    });
    expect(after.displayName).toBe("HAVEN Recruitment");
    // And it is what a send would actually go out as, not merely what the admin
    // screen shows.
    expect(
      (await resolveSenderIdentity(holder.id, null, "recruitment@havenfreeclinic.org"))?.displayName,
    ).toBe("HAVEN Recruitment");

    // Supplying a new one still replaces it: this is a guard against an ABSENT
    // value, not a refusal to ever change the name.
    const third = await person("Third", "third@yale.edu");
    const renamed = await issueSendingIdentity(null, {
      personId: third.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Outreach",
    });
    expect(renamed.displayName).toBe("HAVEN Outreach");
  });

  it("refuses to grant the same address to the same role twice", async () => {
    const editors = await role("Editors", []);
    await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await expect(
      issueSendingIdentity(null, {
        roleId: editors.id,
        address: "recruitment@havenfreeclinic.org",
      }),
    ).rejects.toBeInstanceOf(SenderIdentityError);
  });
});

// ---------------------------------------------------------------------------
// Write-time validation against the allowlist.
// ---------------------------------------------------------------------------

describe("write-time validation", () => {
  it("refuses to issue an address on a domain the allowlist does not carry", async () => {
    // Rejecting at write is the whole point: an identity nothing can DKIM-sign
    // is a campaign that fails after the sender has already hit Send.
    const sender = await person("Scoped Sender", "sender@yale.edu");
    for (const address of ["someone@gmail.com", "someone@mail.yale.edu", "not-an-address"]) {
      await expect(
        issueSendingIdentity(null, { personId: sender.id, address }),
      ).rejects.toBeInstanceOf(SenderIdentityError);
    }
    expect(await prisma.sendingIdentity.count()).toBe(0);
  });

  it("refuses a malformed LOCAL part on an allowlisted domain", async () => {
    // The domain check alone is not a format check. domainOf is deliberately
    // permissive about the local part (it answers "which domain would this be
    // signed under", not "is this deliverable"), so without a format check these
    // store fine and fail at send -- exactly the class of failure a write-time
    // check exists to prevent. Every address below is on a domain the allowlist
    // DOES carry, so only the format check can refuse it.
    const sender = await person("Scoped Sender", "sender@yale.edu");
    for (const address of [
      "a b@havenfreeclinic.org",
      "x@y@havenfreeclinic.org",
      "@havenfreeclinic.org",
      "recruitment@havenfreeclinic.org ,evil@havenfreeclinic.org",
    ]) {
      await expect(
        issueSendingIdentity(null, { personId: sender.id, address }),
      ).rejects.toBeInstanceOf(SenderIdentityError);
    }
    expect(await prisma.sendingIdentity.count()).toBe(0);
  });

  it("records the transport the allowlist gives the address, at both polarities", async () => {
    // The claim is that the recorded transport is READ from the allowlist, not
    // decided here. Only two different answers can show that: an implementation
    // that hardcoded "maileroo" would pass the first of these on its own, and the
    // whole map could collapse to one transport without either half noticing.
    // Both domains below are declared at the top of this file for that reason.
    const sender = await person("Scoped Sender", "sender@yale.edu");
    const clinic = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });
    expect(clinic.transport).toBe("maileroo");
    const routedToGraph = await issueSendingIdentity(null, {
      personId: sender.id,
      address: GRAPH_SIGNED_ADDRESS,
    });
    expect(routedToGraph.transport).toBe("graph");
  });

  it("lists issued identities including revoked ones, so an admin can see the history", async () => {
    const sender = await person("Scoped Sender", "sender@yale.edu");
    const editors = await role("Editors", []);
    const issued = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      roleId: editors.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await revokeSendingIdentity(null, issued.id);

    const rows = await listIssuedIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
    // Both holders, each labelled with WHICH kind it is. A role grant flattened
    // into "the people it currently reaches" would be the wrong record: the
    // durable fact is the role, and who holds it changes without this table.
    expect(rows[0].grants.map((g) => [g.kind, g.targetName])).toEqual([
      ["person", "Scoped Sender"],
      ["role", "Editors"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Resolution order.
// ---------------------------------------------------------------------------

describe("resolution order", () => {
  it("prefers the scope identity, then an issued one, and has no third layer", async () => {
    // A contactEmail on an allowlisted clinic domain throughout, so if a third
    // layer were ever re-added this test would notice rather than shrug.
    const sender = await person("Scoped Sender", "directors@havenfreeclinic.org");
    await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
    });

    // 1. A scope identity outranks everything: an admin set it.
    const withScope = await resolveSenderIdentity(
      sender.id,
      scopeIdentity("peds@havenfreeclinic.org", "HAVEN Pediatrics"),
      null,
    );
    expect(withScope).toMatchObject({
      address: "peds@havenfreeclinic.org",
      displayName: "HAVEN Pediatrics",
      source: "scope",
    });

    // 2. With no scope identity, an address issued to them.
    const withIssued = await resolveSenderIdentity(sender.id, scopeIdentity(null), null);
    expect(withIssued).toMatchObject({
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
      source: "issued",
    });

    // 3. With neither, NULL, not their profile address: the caller falls through
    // to the existing template/category sender rules and then the global
    // default. A sender with nothing issued to them and no scope identity has no
    // claim of their own to fall back on, by design.
    const bare = await person("Bare", "bare@havenfreeclinic.org");
    expect(await resolveSenderIdentity(bare.id, null, null)).toBeNull();
    expect(await resolveSenderIdentity(bare.id, scopeIdentity(null), null)).toBeNull();
  });

  it("offers every claim in order, deduplicated, with the strongest source winning", async () => {
    const sender = await person("Scoped Sender", "shared@havenfreeclinic.org");
    await issueSendingIdentity(null, {
      personId: sender.id,
      address: "shared@havenfreeclinic.org",
      displayName: "Shared",
    });
    await issueSendingIdentity(null, { personId: sender.id, address: "peds@havenfreeclinic.org" });

    const options = await availableSenderIdentities(
      sender.id,
      scopeIdentity("peds@havenfreeclinic.org", "HAVEN Pediatrics"),
    );
    // peds appears once, as the SCOPE claim (the stronger one), not twice.
    expect(options.map((o) => [o.address, o.source])).toEqual([
      ["peds@havenfreeclinic.org", "scope"],
      ["shared@havenfreeclinic.org", "issued"],
    ]);
    // shared@ is BOTH issued to them and the address on their profile, and it
    // appears exactly once, as the issued claim. The profile half contributes
    // nothing at all: it is what makes the address usable, not the fact that
    // they typed it.
    expect(options).toHaveLength(2);
  });

  it("never offers an address the allowlist does not carry, from any layer", async () => {
    // Including the scope layer, whose value is admin-set but could predate the
    // allowlist check or survive an allowlist narrowing.
    const sender = await person("Scoped Sender", "sender@gmail.com");
    await prisma.sendingIdentity.create({
      data: {
        address: "legacy@example.net",
        grants: { create: { personId: sender.id } },
      },
    });
    const options = await availableSenderIdentities(sender.id, scopeIdentity("old@example.net"));
    expect(options).toEqual([]);
    await expect(
      resolveSenderIdentity(sender.id, scopeIdentity("old@example.net"), "old@example.net"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
  });

  it("resolves the scope identity with no person at all", async () => {
    // The dispatch path can reach this with a null person (the chooser left, or
    // a cron run whose campaign has no surviving chooser). The scope layer does
    // not depend on anyone, so it must still resolve.
    expect(
      await resolveSenderIdentity(null, scopeIdentity("peds@havenfreeclinic.org"), null),
    ).toMatchObject({ address: "peds@havenfreeclinic.org", source: "scope" });
    expect(await resolveSenderIdentity(null, null, null)).toBeNull();
  });
});
