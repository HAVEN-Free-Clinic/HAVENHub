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
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  SenderIdentityError,
  availableSenderIdentities,
  issueSendingIdentity,
  listIssuedIdentities,
  resolveSenderIdentity,
  revokeSendingIdentity,
} from "./sender-identity";

beforeEach(resetDb);

/** A scope's identity, in the shape resolveSenderIdentity takes one. */
function scopeIdentity(fromEmail: string | null, fromName: string | null = null) {
  return { fromEmail, fromName };
}

async function person(name: string, contactEmail: string | null) {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
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
    // dean@yale.edu is on yale.edu, which SENDING_DOMAINS carries (Graph-signed),
    // so the allowlist check passes and only the ownership check can stop it.
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
    expect(await availableSenderIdentities(sender.id, null)).toEqual([
      // Only their own address is left.
      expect.objectContaining({ address: "sender@yale.edu", source: "own" }),
    ]);
  });

  it("re-issues in place rather than creating a second row", async () => {
    // The uniqueness constraint is (personId, address), so a revoke-then-reissue
    // has to clear revokedAt on the row that is already there. A second insert
    // would violate the constraint outright.
    const sender = await person("Scoped Sender", "sender@yale.edu");
    const first = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await revokeSendingIdentity(null, first.id);

    const again = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
      displayName: "Back Again",
    });
    expect(again.id).toBe(first.id);
    expect(again.revokedAt).toBeNull();
    expect(again.displayName).toBe("Back Again");
    expect(await prisma.sendingIdentity.count()).toBe(1);

    expect(
      (await resolveSenderIdentity(sender.id, null, "recruitment@havenfreeclinic.org"))?.source,
    ).toBe("issued");
  });

  it("revoking one person's copy of a shared address leaves the other's alone", async () => {
    // Why uniqueness is on the PAIR and not on the address: a shared mailbox is
    // issuable to several people, and each holds it independently.
    const alice = await person("Alice", "alice@yale.edu");
    const bob = await person("Bob", "bob@yale.edu");
    const hers = await issueSendingIdentity(null, {
      personId: alice.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await issueSendingIdentity(null, {
      personId: bob.id,
      address: "recruitment@havenfreeclinic.org",
    });

    await revokeSendingIdentity(null, hers.id);

    await expect(
      resolveSenderIdentity(alice.id, null, "recruitment@havenfreeclinic.org"),
    ).rejects.toBeInstanceOf(SenderIdentityError);
    expect(
      (await resolveSenderIdentity(bob.id, null, "recruitment@havenfreeclinic.org"))?.address,
    ).toBe("recruitment@havenfreeclinic.org");
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

  it("accepts an address on either allowlisted domain and records the transport", async () => {
    // Both polarities of the allowlist, and both signing transports, because the
    // two domains are signable by DIFFERENT ones.
    const sender = await person("Scoped Sender", "sender@yale.edu");
    const clinic = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });
    expect(clinic.transport).toBe("maileroo");
    const yale = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "hfc.it@yale.edu",
    });
    expect(yale.transport).toBe("graph");
  });

  it("lists issued identities including revoked ones, so an admin can see the history", async () => {
    const sender = await person("Scoped Sender", "sender@yale.edu");
    const issued = await issueSendingIdentity(null, {
      personId: sender.id,
      address: "recruitment@havenfreeclinic.org",
    });
    await revokeSendingIdentity(null, issued.id);
    const rows = await listIssuedIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].personName).toBe("Scoped Sender");
  });
});

// ---------------------------------------------------------------------------
// Resolution order.
// ---------------------------------------------------------------------------

describe("resolution order", () => {
  it("prefers the scope identity, then an issued one, then the sender's own", async () => {
    const sender = await person("Scoped Sender", "sender@yale.edu");
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

    // 2. With no scope identity, an issued address outranks their own.
    const withIssued = await resolveSenderIdentity(sender.id, scopeIdentity(null), null);
    expect(withIssued).toMatchObject({
      address: "recruitment@havenfreeclinic.org",
      displayName: "HAVEN Recruitment",
      source: "issued",
    });

    // 3. With neither, their own address, which is always theirs to use.
    const bare = await person("Bare", "bare@yale.edu");
    expect(await resolveSenderIdentity(bare.id, null, null)).toMatchObject({
      address: "bare@yale.edu",
      source: "own",
    });

    // 4. With none of the three, null: the caller falls through to the existing
    // template/category sender rules and then the global default.
    const outsider = await person("Outsider", "outsider@gmail.com");
    expect(await resolveSenderIdentity(outsider.id, null, null)).toBeNull();
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
    // And the sender's own address, which is also the shared issued one, has not
    // produced a third entry.
    expect(options).toHaveLength(2);
  });

  it("never offers an address the allowlist does not carry, from any layer", async () => {
    // Including the scope layer, whose value is admin-set but could predate the
    // allowlist check or survive an allowlist narrowing.
    const sender = await person("Scoped Sender", "sender@gmail.com");
    await prisma.sendingIdentity.create({
      data: { personId: sender.id, address: "legacy@example.net" },
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
