/**
 * Auto-issuing a sender their OWN address, and the admin act that approves it.
 *
 * Task 2 removed Person.contactEmail as a resolution layer, and correctly: it is
 * self-service unverified free text, so "it is theirs" reduced to "it is the
 * value I just typed" and a delegated sender could mint directors@ on a
 * DKIM-signing domain. See the module note in sender-identity.ts.
 *
 * This file covers the restoration of the convenience by a DIFFERENT mechanism,
 * which rests on exactly two properties. Each has its own describe block below,
 * and neither is worth anything without the other:
 *
 *   THE SNAPSHOT. The address is read ONCE, at issue time, into a
 *   SendingIdentity row. Nothing resolves against the profile field afterwards,
 *   so editing it changes nothing about what the sender may send as. That is the
 *   whole difference between this and what was removed.
 *
 *   THE APPROVAL. The snapshot is taken by an admin who was SHOWN that exact
 *   address and submitted it back. A bare grantScope -- a caller that displayed
 *   nothing to anybody -- confers no address at all. Without this the first
 *   property would merely freeze whatever the sender had typed before somebody
 *   granted them a scope, which is the same Critical arriving by a longer road.
 *
 * THE SHARPEST CASE, and the reason this is not simply "issue on grant":
 * a REVOKED address must stay revoked. An admin said no to that address once; a
 * later scope grant is a different decision about a different thing and is not a
 * reversal of it.
 *
 * Addresses here are on the SHIPPED allowlist (havenfreeclinic.org, yale.edu)
 * except where a test is specifically about an unsignable one. That matters for
 * the same reason it does in sender-identity.test.ts: a case using an unlisted
 * domain throughout would pass against an implementation with no auto-issue at
 * all, because the allowlist alone would have refused it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { grantScope, revokeScope, ScopeValidationError } from "./audience/scopes";
import {
  availableSenderIdentities,
  describeAutoIssue,
  issueOwnAddress,
  issueSendingIdentity,
  listIssuedIdentities,
  revokeSendingIdentity,
  sendersWithoutIdentity,
} from "./sender-identity";

beforeEach(resetDb);

let seq = 0;

async function person(name: string, contactEmail: string | null) {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
}

async function scope(name = `Scope ${(seq += 1)}`) {
  return prisma.audienceScope.create({
    data: { name, audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] } },
  });
}

/**
 * A role that grants `permission`, optionally assigned to people.
 *
 * termId: null on purpose, matching sender-identity.test.ts and scopes.test.ts:
 * these cases are about who holds an outreach permission, not about term
 * scoping, and roleIdsForPerson / peopleWithAnyPermission both resolve a
 * person-targeted global assignment with no term fixture at all.
 */
async function roleGranting(permission: string, members: Array<{ id: string }> = []) {
  const role = await prisma.role.create({
    data: { name: `Role ${permission} ${(seq += 1)}`, grants: { create: [{ permission }] } },
  });
  for (const m of members) {
    await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: m.id, termId: null },
    });
  }
  return role;
}

/**
 * What the scope grant SCREEN does: grant, approving the address it printed.
 *
 * Every person-grant case below goes through this rather than through a bare
 * grantScope, because a bare grantScope deliberately issues nothing -- see
 * "the approval is what confers the address" for the case that pins that.
 */
async function grantApproving(
  actorId: string | null,
  scopeId: string,
  personId: string,
  approvedAddress: string,
) {
  return grantScope(actorId, scopeId, { personId }, approvedAddress);
}

/** Just the addresses this person may send as, with no scope identity in play. */
async function issuedAddresses(personId: string): Promise<string[]> {
  const options = await availableSenderIdentities(personId, null);
  return options.map((o) => o.address);
}

// ---------------------------------------------------------------------------
// The hook: a person-targeted scope grant, and only that one.
// ---------------------------------------------------------------------------

describe("auto-issue on a scope grant", () => {
  it("issues the granted person's own address, attributed to the granting admin", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");
    const s = await scope();

    await grantApproving(admin.id, s.id, sender.id, "sender@havenfreeclinic.org");

    expect(await issuedAddresses(sender.id)).toEqual(["sender@havenfreeclinic.org"]);

    // Attributed to the ADMIN, not to the sender: this is an admin act, and a
    // self-attributed row would make the approval circular.
    const [issued] = await listIssuedIdentities();
    const row = await prisma.sendingIdentity.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.createdById).toBe(admin.id);
    expect(issued.grants.map((g) => ({ kind: g.kind, personId: g.personId }))).toEqual([
      { kind: "person", personId: sender.id },
    ]);
  });

  it("issues NOTHING for a role-targeted grant, because a role has no address", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const member = await person("Role Member", "member@havenfreeclinic.org");
    const role = await roleGranting("outreach.send", [member]);
    const s = await scope();

    await grantScope(admin.id, s.id, { roleId: role.id });

    // The scope grant itself landed...
    expect(await prisma.audienceScopeGrant.count({ where: { roleId: role.id } })).toBe(1);
    // ...and nothing was issued, to the role or to anyone it reaches. Asserting
    // the member's own list too, not just the table count: an implementation
    // that resolved the role to its members and issued each of THEM their own
    // address would satisfy a count of the identities table alone if it also
    // happened to be empty for some other reason.
    expect(await listIssuedIdentities()).toEqual([]);
    expect(await issuedAddresses(member.id)).toEqual([]);
  });

  it("does not change what the sender may send as when they later edit their profile", async () => {
    // THE SNAPSHOT. The removed layer read contactEmail at RESOLVE time, so
    // editing the field changed the From. This one snapshots it at ISSUE time,
    // so editing the field afterwards is inert -- including editing it to a role
    // address on a Maileroo-signed domain, which is the exact escalation that
    // closed the original hole.
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");
    await grantApproving(admin.id, (await scope()).id, sender.id, "sender@havenfreeclinic.org");
    expect(await issuedAddresses(sender.id)).toEqual(["sender@havenfreeclinic.org"]);

    await prisma.person.update({
      where: { id: sender.id },
      data: { contactEmail: "directors@havenfreeclinic.org" },
    });

    // The issued address is unchanged, and the newly typed one is not offered.
    expect(await issuedAddresses(sender.id)).toEqual(["sender@havenfreeclinic.org"]);
  });
});

// ---------------------------------------------------------------------------
// The approval. Without it the snapshot merely freezes whatever the sender
// typed before somebody granted them a scope.
// ---------------------------------------------------------------------------

describe("the approval is what confers the address", () => {
  it("issues NOTHING when the caller approved no address", async () => {
    // A bare grantScope is a caller that displayed nothing to anybody, so there
    // is nobody who read the address and no approval to act on. This is the
    // posture the campaign service tests depend on: their fixture's sender
    // carries directors@havenfreeclinic.org precisely because it is the
    // dangerous shape, and granting them a scope must not hand it over.
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "directors@havenfreeclinic.org");

    await grantScope(admin.id, (await scope()).id, { personId: sender.id });

    expect(await listIssuedIdentities()).toEqual([]);
    expect(await issuedAddresses(sender.id)).toEqual([]);
  });

  it("refuses when the profile changed after the screen printed the address", async () => {
    // The window the approval exists to close. The admin reads "Also issues
    // sender@...", and between that render and the click the person edits their
    // own profile to an unclaimed clinic role address. Issuing the CURRENT value
    // would hand over a string no human ever approved.
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");
    await prisma.person.update({
      where: { id: sender.id },
      data: { contactEmail: "directors@havenfreeclinic.org" },
    });

    const s = await scope();
    await grantApproving(admin.id, s.id, sender.id, "sender@havenfreeclinic.org");

    // The scope grant still lands: it is a separate decision and it succeeded.
    expect(await prisma.audienceScopeGrant.count({ where: { personId: sender.id } })).toBe(1);
    // Nothing at all is issued -- not the stale approved address, and above all
    // not the address that replaced it.
    expect(await listIssuedIdentities()).toEqual([]);
    expect(await issuedAddresses(sender.id)).toEqual([]);
  });

  it("cannot be used to name an address that is not theirs", async () => {
    // The parameter is matched, never written, so it is not a channel for
    // choosing an address. A caller naming a real, live, admin-issued identity
    // belonging to somebody else gets a refusal, not a grant on it.
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const colleague = await person("Colleague", "recruitment@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");
    await issueSendingIdentity(admin.id, {
      personId: colleague.id,
      address: "recruitment@havenfreeclinic.org",
    });

    const result = await issueOwnAddress(admin.id, sender.id, "recruitment@havenfreeclinic.org");

    expect(result.issued).toBe(false);
    expect(await issuedAddresses(sender.id)).toEqual([]);
    // And the colleague's identity is untouched: still exactly one holder.
    const [identity] = await listIssuedIdentities();
    expect(identity.grants.map((g) => g.personId)).toEqual([colleague.id]);
  });

  it("tells the grant screen the exact address it is approving", async () => {
    // The screen prints describeAutoIssue's sentence and submits its
    // issuableAddress back. If the two ever disagreed, the admin would be
    // approving something other than what they read, so they come from one call.
    const revokedHolder = await person("Revoked", "revoked@havenfreeclinic.org");
    const issuable = await person("Issuable", "fresh@havenfreeclinic.org");
    const unsignable = await person("Gmail", "someone@gmail.com");
    const none = await person("No Address", null);
    const issued = await issueSendingIdentity(null, {
      personId: revokedHolder.id,
      address: "revoked@havenfreeclinic.org",
    });
    await revokeSendingIdentity(null, issued.id);

    const preview = await describeAutoIssue([revokedHolder, issuable, unsignable, none]);

    expect(preview.get(issuable.id)?.issuableAddress).toBe("fresh@havenfreeclinic.org");
    expect(preview.get(issuable.id)?.note).toContain("fresh@havenfreeclinic.org");
    // Nothing to approve in the three refusal cases, so the screen submits
    // nothing and the grant is a plain grant.
    expect(preview.get(revokedHolder.id)?.issuableAddress).toBeNull();
    expect(preview.get(revokedHolder.id)?.note).toMatch(/revoked/i);
    expect(preview.get(unsignable.id)?.issuableAddress).toBeNull();
    expect(preview.get(none.id)?.issuableAddress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sharpest case.
// ---------------------------------------------------------------------------

describe("a revoked address is not resurrected", () => {
  it("leaves a revoked identity revoked when a later scope grant would re-issue it", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");

    // The admin issues it, then takes it away. That refusal is the durable fact.
    const issued = await issueSendingIdentity(admin.id, {
      personId: sender.id,
      address: "sender@havenfreeclinic.org",
    });
    await revokeSendingIdentity(admin.id, issued.id);
    expect(await issuedAddresses(sender.id)).toEqual([]);
    // Retiring the ADDRESS deliberately leaves the old grant row in place, so
    // the screen can still say who used to hold it. That is the baseline the
    // assertion below is against.
    const grantsBefore = issued.grants.map((g) => g.id);
    expect(grantsBefore).toHaveLength(1);

    // A grant is a decision about an AUDIENCE, not a reversal of that refusal --
    // and this one even carries the approval, which is the strongest form of the
    // case: an admin actively naming the address does not undo the revocation.
    await grantApproving(admin.id, (await scope()).id, sender.id, "sender@havenfreeclinic.org");

    expect(await issuedAddresses(sender.id)).toEqual([]);
    const rows = await listIssuedIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
    // And NO NEW grant was hung off the retired row. Checking the flag alone
    // would pass against an implementation that added a grant and relied on the
    // read filter to hide it, which is a second thing to remember rather than a
    // refusal -- and it is the exact shape of the ServiceCredential bug this
    // feature has been avoiding throughout.
    expect(rows[0].grants.map((g) => g.id)).toEqual(grantsBefore);
  });

  it("says why, rather than silently doing nothing, on the one-click path", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Unrestricted Sender", "sender@havenfreeclinic.org");
    const issued = await issueSendingIdentity(admin.id, {
      personId: sender.id,
      address: "sender@havenfreeclinic.org",
    });
    await revokeSendingIdentity(admin.id, issued.id);

    const result = await issueOwnAddress(admin.id, sender.id, "sender@havenfreeclinic.org");
    expect(result.issued).toBe(false);
    expect(result.issued === false && result.reason).toMatch(/revoked/i);
    expect(await issuedAddresses(sender.id)).toEqual([]);
  });

  it("says so on the gap list too, so the admin is not offered a dead click", async () => {
    // The refusal is enforced TWICE on purpose -- once before the write, and
    // once on the row the upsert returns, which is the only guard a concurrent
    // revoke cannot slip past. This case pins the FIRST of the two: it is the
    // one the gap list reads, and it is the difference between a button that
    // explains itself and one that silently does nothing.
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Unrestricted Sender", "sender@havenfreeclinic.org");
    await roleGranting("outreach.send_unrestricted", [sender]);
    const issued = await issueSendingIdentity(admin.id, {
      personId: sender.id,
      address: "sender@havenfreeclinic.org",
    });
    await revokeSendingIdentity(admin.id, issued.id);

    const gap = await sendersWithoutIdentity();
    expect(gap).toHaveLength(1);
    expect(gap[0].personId).toBe(sender.id);
    expect(gap[0].blocker).toMatch(/revoked/i);
  });
});

// ---------------------------------------------------------------------------
// The identity is a bonus, never a precondition.
// ---------------------------------------------------------------------------

describe("the grant still succeeds when nothing can be issued", () => {
  it("grants the scope when the person's address is on no allowlisted domain", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    // gmail.com is deliberately NOT in DEFAULT_SENDING_DOMAINS: no transport can
    // DKIM-sign for it, so it is exactly what must not become an identity. The
    // approval is passed anyway, so the refusal comes from the allowlist check
    // inside the issue path rather than from the screen having withheld it.
    const sender = await person("Gmail Sender", "sender@gmail.com");
    const s = await scope();

    await expect(
      grantApproving(admin.id, s.id, sender.id, "sender@gmail.com"),
    ).resolves.toBeUndefined();

    expect(await prisma.audienceScopeGrant.count({ where: { personId: sender.id } })).toBe(1);
    expect(await listIssuedIdentities()).toEqual([]);
  });

  it("grants the scope when the person has no contact email at all", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("No Address", null);
    const s = await scope();

    // An approval is passed even though there is nothing on file, so the grant
    // is exercised against the path where the issue attempt genuinely runs and
    // refuses, not the one where it was never attempted.
    await expect(
      grantApproving(admin.id, s.id, sender.id, "ghost@havenfreeclinic.org"),
    ).resolves.toBeUndefined();

    expect(await prisma.audienceScopeGrant.count({ where: { personId: sender.id } })).toBe(1);
    expect(await listIssuedIdentities()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Idempotence: one click, one failure mode.
// ---------------------------------------------------------------------------

describe("issuing is idempotent", () => {
  it("issues once across several grants to the same person", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");
    const address = "sender@havenfreeclinic.org";

    await grantApproving(admin.id, (await scope("Peds")).id, sender.id, address);
    await grantApproving(admin.id, (await scope("Adult")).id, sender.id, address);

    const rows = await listIssuedIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].grants).toHaveLength(1);
    expect(await issuedAddresses(sender.id)).toEqual([address]);
  });

  it("survives revoking a scope grant and granting it again", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");
    const address = "sender@havenfreeclinic.org";
    const s = await scope();

    await grantApproving(admin.id, s.id, sender.id, address);
    const grant = await prisma.audienceScopeGrant.findFirstOrThrow({
      where: { scopeId: s.id, personId: sender.id },
    });
    await revokeScope(admin.id, grant.id);
    await expect(grantApproving(admin.id, s.id, sender.id, address)).resolves.toBeUndefined();

    const rows = await listIssuedIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].grants).toHaveLength(1);
  });

  it("keeps a duplicate grant's ONE failure mode, rather than adding a second", async () => {
    // grantScope already translates the duplicate-grant P2002 into a typed
    // error. Auto-issue must not turn the same click into a different, second
    // failure -- an unhandled P2002 out of the identity write would reach the
    // generic error boundary instead of the scope page's ?error= handling.
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "sender@havenfreeclinic.org");
    const address = "sender@havenfreeclinic.org";
    const s = await scope();

    await grantApproving(admin.id, s.id, sender.id, address);
    await expect(grantApproving(admin.id, s.id, sender.id, address)).rejects.toBeInstanceOf(
      ScopeValidationError,
    );

    expect(await listIssuedIdentities()).toHaveLength(1);
  });

  it("adds nothing when the person already holds that address through a role", async () => {
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Scoped Sender", "shared@havenfreeclinic.org");
    const role = await roleGranting("outreach.send", [sender]);
    await issueSendingIdentity(admin.id, {
      roleId: role.id,
      address: "shared@havenfreeclinic.org",
    });

    await grantApproving(
      admin.id,
      (await scope()).id,
      sender.id,
      "shared@havenfreeclinic.org",
    );

    // ONE address, offered once, and the person grant is added BESIDE the role
    // one rather than failing: they are two routes to one row, which is the
    // shape the Task 3 split exists for. Asserting both grants rather than only
    // the deduplicated menu, because the menu alone already read correctly
    // through the role and so would pass whether the person grant landed or not.
    const rows = await listIssuedIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].grants.map((g) => g.kind).sort()).toEqual(["person", "role"]);
    expect(await issuedAddresses(sender.id)).toEqual(["shared@havenfreeclinic.org"]);
  });
});

// ---------------------------------------------------------------------------
// The one-click path, and the population auto-issue cannot reach.
// ---------------------------------------------------------------------------

describe("the one-click path on the identities page", () => {
  it("issues for an unrestricted sender who has no scope grant at all", async () => {
    // The population the scope-grant hook structurally misses: outreach.send
    // and outreach.send_unrestricted are carried by ROLES, so this person is
    // never the subject of a person-targeted outreach event, and holding
    // send_unrestricted they need no scope grant either. Before this path they
    // had zero From options and no page on which to fix it.
    const admin = await person("Admin", "admin@havenfreeclinic.org");
    const sender = await person("Unrestricted Sender", "blast@havenfreeclinic.org");
    await roleGranting("outreach.send_unrestricted", [sender]);

    expect(await prisma.audienceScopeGrant.count()).toBe(0);
    expect(await issuedAddresses(sender.id)).toEqual([]);

    const gap = await sendersWithoutIdentity();
    expect(gap.map((g) => ({ personId: g.personId, address: g.address, blocker: g.blocker }))).toEqual(
      [{ personId: sender.id, address: "blast@havenfreeclinic.org", blocker: null }],
    );

    const result = await issueOwnAddress(admin.id, sender.id, "blast@havenfreeclinic.org");
    expect(result.issued).toBe(true);
    expect(await issuedAddresses(sender.id)).toEqual(["blast@havenfreeclinic.org"]);

    // And the gap closes, which is what makes the list a to-do rather than a roster.
    expect(await sendersWithoutIdentity()).toEqual([]);
  });

  it("lists a scoped sender whose scope arrived through a role", async () => {
    // The second missed population: the grant is on the ROLE, so the
    // person-targeted hook never fired for them.
    const sender = await person("Role-Scoped Sender", "scoped@havenfreeclinic.org");
    const role = await roleGranting("outreach.send", [sender]);
    await grantScope(null, (await scope()).id, { roleId: role.id });

    expect(await issuedAddresses(sender.id)).toEqual([]);
    expect((await sendersWithoutIdentity()).map((g) => g.personId)).toEqual([sender.id]);
  });

  it("names the blocker instead of offering a click that cannot work", async () => {
    const unsignable = await person("Gmail Sender", "sender@gmail.com");
    const missing = await person("No Address", null);
    await roleGranting("outreach.send", [unsignable, missing]);

    const gap = await sendersWithoutIdentity();
    expect(gap).toHaveLength(2);
    const byId = new Map(gap.map((g) => [g.personId, g]));
    expect(byId.get(unsignable.id)?.address).toBe("sender@gmail.com");
    expect(byId.get(unsignable.id)?.blocker).toMatch(/verified sending domain/i);
    expect(byId.get(missing.id)?.address).toBeNull();
    expect(byId.get(missing.id)?.blocker).toMatch(/contact email/i);

    // And the click itself refuses, not merely the label: the page is not the
    // enforcement point.
    expect((await issueOwnAddress(null, unsignable.id, "sender@gmail.com")).issued).toBe(false);
    expect((await issueOwnAddress(null, missing.id, "ghost@havenfreeclinic.org")).issued).toBe(
      false,
    );
    expect(await listIssuedIdentities()).toEqual([]);
  });

  it("leaves out people who hold no outreach sending permission", async () => {
    // A scope ADMIN is not a sender. Listing every person with any outreach
    // permission would make the gap list a roster nobody reads.
    const scopeAdmin = await person("Scope Admin", "boss@havenfreeclinic.org");
    await roleGranting("outreach.manage_scopes", [scopeAdmin]);
    const nobody = await person("Ordinary Member", "member@havenfreeclinic.org");
    expect(nobody.id).toBeTruthy();

    expect(await sendersWithoutIdentity()).toEqual([]);
  });
});
