/**
 * Sender identity: which addresses a person may send a campaign as.
 *
 * Task 1 (sending-domains.ts) decided HOW a From address is delivered -- which
 * transport can DKIM-sign for its domain. This module decides WHO may use one,
 * which is the security half. Sender identity is a claim about the clinic, and
 * delegation is worthless if a delegated sender can put an arbitrary address in
 * the From, so the ordering below is not merely a preference list: it is also
 * the exhaustive set of addresses a given person is permitted to send as.
 *
 * THE ORDER, strongest claim first. There are TWO layers, and both of them are
 * something an ADMIN did:
 *
 *   1. The campaign's SCOPE identity (AudienceScope.fromEmail / fromName). An
 *      admin set it on the delegation boundary itself, so it is the strongest
 *      claim available and outranks anything the sender holds personally.
 *   2. An address explicitly ISSUED to the sender (SendingIdentity). This is the
 *      delegatable half: an admin hands a specific person a specific address.
 *
 *   ...then null, meaning the caller falls through to the existing per-template
 *   and per-category sender rules and finally the global email.sender setting.
 *
 * NOT IN THE ORDER: anything the sender types at compose time that is not one of
 * the two above. The compose UI offers a choice AMONG the resolved identities;
 * it does not accept a free-text address, and resolveSenderIdentity refuses one.
 *
 * ALSO NOT IN THE ORDER, AND DO NOT RE-ADD IT: the sender's own
 * Person.contactEmail. It was layer 3 in the original design, on the reasoning
 * that an address is theirs to use. It is not, and the reason is worth stating
 * at length because "let a sender use their own address" reads as an obvious
 * convenience and will be proposed again:
 *
 *   - Person.contactEmail is SELF-SERVICE UNVERIFIED FREE TEXT. Members write it
 *     on /my-info; nothing anywhere proves control of it. A Yale user
 *     authenticates by netId, so even they have not proven control of that
 *     field. So "it is theirs" reduces to "it is the value I just typed".
 *   - The allowlist cannot rescue it. The allowlist is DOMAIN-level by
 *     construction (see sending-domains.ts) and cannot tell sender@ from
 *     directors@. havenfreeclinic.org is Maileroo-signed, so an address on it
 *     leaves AS ITSELF, DKIM-aligned, under DMARC p=reject -- with none of the
 *     Send-As brake that happens to slow yale.edu down.
 *   - Reproduced end to end before it was closed: a person holding only
 *     outreach.send plus one scope grant set their profile to
 *     directors@havenfreeclinic.org, picked it, and the campaign enqueued from
 *     it. contactEmail is @unique, so a specific colleague's address is blocked,
 *     but every unclaimed role address (directors@, info@, president@,
 *     billing@) was open.
 *   - An admin-set scope identity did not displace it. Every layer is APPENDED
 *     to one option list, so a scope identity sat beside the typed address
 *     rather than replacing it.
 *
 * Re-adding it needs a proof-of-control mechanism this codebase does not have.
 * Until then, an address the clinic signs as itself comes from an issued row or
 * an admin-set scope identity, and from nowhere else.
 *
 * THE CONVENIENCE IS BACK, BY A DIFFERENT MECHANISM, AND THE PARAGRAPHS ABOVE
 * STILL STAND WORD FOR WORD. issueOwnAddress lets an ADMIN approve a person's
 * current contactEmail once, which SNAPSHOTS it into an ordinary SendingIdentity
 * row; from then on it is layer 2 like any other issued address and this module
 * never looks at the profile field again. That is the entire difference:
 *
 *   the removed layer read contactEmail at RESOLVE time, so the sender chose
 *   their own From by editing their own profile, at any moment, unilaterally;
 *
 *   the snapshot is read at ISSUE time by somebody holding
 *   outreach.manage_scopes, and editing the profile afterwards changes nothing
 *   at all -- not the issued address, not the menu, not the authorization check.
 *
 * So the thing that must never come back is a resolve-time read of that field,
 * and it has not. What an admin approves is a specific string on a specific day.
 * The residual risk is correspondingly narrow and is the admin's to see rather
 * than the sender's to exploit: whoever grants must be looking at the address
 * they are approving, which is why the grant and identities screens both PRINT
 * it beside the button rather than issuing something invisible.
 *
 * THE COST OF THE ORIGINAL REMOVAL, and what has since been done about it:
 * nobody can send as anything but an admin-issued address or their campaign's
 * scope identity. That binds an outreach.send_unrestricted holder too, not only
 * a scoped one -- the two permissions are separate in
 * platform/modules/registry.ts, so a person who may send to anyone but does not
 * hold outreach.manage_scopes had ZERO From options and no page on which to
 * grant themselves one. Issuing stays an admin act (self-issue is exactly what
 * would make the check circular), but the gap is no longer invisible:
 * sendersWithoutIdentity lists every holder of a sending permission who has no
 * active identity, on the identities page, one click from a fix.
 *
 * A STALE COMMENT, left alone on purpose but NOT for the reason first given
 * here: migration 20260902140000_sending_identity's header still describes the
 * removed layer as current. The original note claimed a comment-only edit to an
 * applied migration "breaks `migrate deploy` and `migrate status`". It does not.
 * Measured on Prisma 6.19.3 against a template that had the pre-edit file
 * applied: both commands report clean and exit 0 while the recorded checksum and
 * the file's checksum differ. The error string that claim borrowed belongs to
 * `migrate dev`, which is a different command.
 *
 * The real residual is narrow, and it is worth knowing before editing any
 * applied migration: `npm run db:migrate` IS `prisma migrate dev`, so a
 * developer whose local database already applied the pre-edit file gets prompted
 * to reset. `npm run test:prepare` and the Vercel build both use
 * `migrate deploy` and are unaffected. 20260902160000's header was edited on
 * exactly this basis and nothing broke.
 *
 * So that header stays stale by choice (churning an applied migration for prose
 * has a cost and no benefit), not by necessity. This module is the authority on
 * the order; that header is not.
 *
 * EVERY LAYER IS VALIDATED WHEN IT IS WRITTEN, and filtered again when it is
 * read. Rejecting at write is the point: an identity nothing can sign is a
 * campaign that fails after the sender has already hit Send. Filtering again at
 * read covers a row written before a check existed, or one whose domain left the
 * allowlist afterwards.
 *
 * REVOCATION IS A FLIP, NOT A DELETE, AND IT IS ON THE ADDRESS. Task 3 split
 * SendingIdentity into the address and its holders (SendingIdentityGrant), so
 * revokedAt now retires the ADDRESS -- through every route to it, direct grant
 * and role grant alike -- and is still the sole validity signal every read here
 * filters on. Keeping it there rather than on the grant is what makes that
 * structurally true rather than a property of remembering to filter N places:
 * every route passes through the identity row, so a grant added later cannot
 * resurrect a retired address. ServiceCredential shipped exactly the opposite
 * bug -- a presence-only relation check counted a revoked credential as held
 * (see the hasServiceCredential note in audience/person-fields.ts) -- and the
 * same shape would be worse here, because the thing it wrongly grants is the
 * right to speak as the clinic.
 *
 * A ROLE GRANT IS EXPANDED LIVE, NEVER SNAPSHOTTED. availableSenderIdentities
 * calls roleIdsForPerson -- the SAME helper scopesForPerson uses, not a second
 * expansion -- and nothing persists the answer. So losing a role loses the
 * identity on the next REQUEST that resolves, with no save and no refresh in
 * between, and because resolveCampaignSender goes through this one function, the
 * enqueue-time re-resolve re-expands roles for free. Role loss between Save and
 * Send is the same class of event as a revocation between Save and Send, and it
 * gets the same treatment because it travels the same code path.
 *
 * "Live" means per request, not per call: roleIdsForPerson is React-cache()d, so
 * one request reuses one answer, and the cron drain is a single request of up to
 * five minutes. That window is stated in full at the query itself, along with
 * why it is not worth closing.
 */
import { Prisma } from "@prisma/client";
import {
  prisma,
  isUniqueConstraintError,
  isForeignKeyConstraintError,
} from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { roleIdsForPerson } from "@/platform/rbac/engine";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { signingTransportFor, type SigningTransport } from "./sending-domains";
import { connectedGraphMailbox } from "./oauth";
import { orgDisplayName } from "./sender-rules";
import { EMAIL_RE } from "./address";

/** A refusal: an address nobody can sign, or one this person may not use. */
export class SenderIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderIdentityError";
  }
}

/**
 * Which layer of the order a resolved identity came from. Both values name
 * something an ADMIN did. There is deliberately no "own": see the module note.
 */
export type SenderIdentitySource = "scope" | "issued";

/** One address a person may send as, with the claim that permits it. */
export type SenderIdentityOption = {
  address: string;
  /** Cosmetic only. Never part of DKIM/SPF alignment. */
  displayName: string | null;
  source: SenderIdentitySource;
  /** The transport that can DKIM-sign for it. Non-null by construction. */
  transport: SigningTransport;
};

/** One holder of one identity: a person, or a role, never both. */
export type SendingIdentityGrantView = {
  id: string;
  personId: string | null;
  roleId: string | null;
  /** The person's or the role's name, whichever this grant targets. */
  targetName: string;
  kind: "person" | "role";
  grantedAt: Date;
};

/** An issued address as the admin screen shows it, revoked ones included. */
export type IssuedIdentityView = {
  id: string;
  address: string;
  displayName: string | null;
  transport: SigningTransport | null;
  createdAt: Date;
  revokedAt: Date | null;
  /** Every holder, person and role alike. Empty means nobody can send as it. */
  grants: SendingIdentityGrantView[];
};

/** Who an address is being issued to. Exactly one, mirroring grantScope. */
export type SendingIdentityTarget = { personId: string } | { roleId: string };

/** Just the two identity columns of a scope, so callers can pass a row or a view. */
export type ScopeIdentity = { fromEmail: string | null; fromName: string | null };

/**
 * Lowercase and trim, or null for anything that is not usable as an address.
 *
 * Lowercasing is what makes SendingIdentity's UNIQUE(address) behave
 * case-insensitively without a raw-SQL expression index, which a later
 * `prisma migrate diff` would propose DROPping. (It used to say the unique was
 * on (personId, address); 20260902160000 replaced that pair with a global unique
 * on the address alone when it split holders into SendingIdentityGrant.) It is
 * also what makes an authorization comparison case-blind in the safe direction:
 * a differently-cased request matches a held address, and no casing turns an
 * unheld one into a held one.
 */
export function normalizeSendingAddress(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Why this address cannot be a sending identity, or null when it can be one.
 *
 * TWO checks, and both are needed at every write seam:
 *
 *   FORMAT, via the shared EMAIL_RE. The domain check below cannot stand in for
 *   it: domainOf is deliberately permissive about the local part (it answers
 *   "which domain would this be signed under", not "is this deliverable"), so
 *   "a b@havenfreeclinic.org" and "x@y@havenfreeclinic.org" both pass it, store
 *   fine, and fail at send -- the exact class of failure a write-time check
 *   exists to prevent. EMAIL_RE is the pattern saveSenderRule already applies,
 *   shared rather than reinvented.
 *
 *   SIGNABILITY, via signingTransportFor and nothing else. No consumer in this
 *   module names a domain, so re-enabling Maileroo's yale.edu entry stays the
 *   one-line change sending-domains.ts documents.
 *
 * `graphMailbox` IS REQUIRED, not optional, and that is the point of it. The
 * connected mailbox is Graph-routed with no list entry, so a check that omits it
 * answers a different question from the one the drain asks. While it was
 * optional this file quietly kept the old answer at four seams and the
 * identities screen contradicted itself: the Transport column (from
 * `toIssuedView`) printed "maileroo" for the connected mailbox while
 * SenderIdentityNotes, rendered from the same array ninety lines below, said it
 * sends through Microsoft Graph. Worse on the clinic's real state, where the
 * mailbox sits on a SUBDOMAIN that deliberately does not inherit its parent's
 * verdict: the notes called it usable while this function refused it outright.
 *
 * Required, so tsc names any new caller that has not decided. Pass null only
 * when there genuinely is no connected mailbox; `connectedGraphMailbox()` is how
 * every caller in this module gets it.
 *
 * Exposed as a reason rather than only as a throw so that the scope editor --
 * which reports its refusals as ScopeValidationError, not as this module's error
 * type -- can reuse exactly this check instead of writing a second one.
 */
export function sendingAddressProblem(
  address: string | null | undefined,
  graphMailbox: string | null,
): string | null {
  const normalized = normalizeSendingAddress(address);
  if (!normalized) return "Enter an email address.";
  if (!EMAIL_RE.test(normalized)) return `"${normalized}" is not a valid email address.`;
  if (signingTransportFor(normalized, graphMailbox)) return null;
  return (
    // Both levers, since either can make an address usable now: SENDING_DOMAINS
    // verifies a whole domain, GRAPH_SENDER_ADDRESSES names one mailbox. Naming
    // only the first would tell an admin holding a perfectly good shared mailbox
    // on an unlisted domain that their one option is to verify the domain.
    `"${normalized}" is not on a verified sending domain, so no transport can sign for it. ` +
    `Use an address on a domain listed in SENDING_DOMAINS, or add this mailbox to ` +
    `GRAPH_SENDER_ADDRESSES if Microsoft Graph holds it.`
  );
}

/** The transport that can sign for a usable address, or a refusal. */
export function assertSignable(address: string, graphMailbox: string | null): SigningTransport {
  const reason = sendingAddressProblem(address, graphMailbox);
  if (reason) throw new SenderIdentityError(reason);
  // Non-null: sendingAddressProblem returned null precisely because this did not.
  return signingTransportFor(address, graphMailbox) as SigningTransport;
}

// ---------------------------------------------------------------------------
// Issuing and revoking
// ---------------------------------------------------------------------------

/**
 * Issue an address to a person or a role, restoring it if it was retired.
 *
 * ONE CALL DOES BOTH JOBS -- mint the address and hand it to a holder -- because
 * after the Task 3 split they are two writes to two tables and an admin screen
 * that made you do them separately would leave an address with no holder as its
 * most common outcome. Issuing an address that already exists simply adds a
 * grant, which is how a shared mailbox reaches several people now that it is one
 * row rather than one row each.
 *
 * Upsert on the address rather than insert, because retiring an address flips
 * revokedAt on the row instead of deleting it: a second insert would violate the
 * unique constraint, so re-issuing has to clear the flag in place. That is the
 * same shape restoreServiceCredential already uses.
 *
 * RE-ISSUING A RETIRED ADDRESS UN-RETIRES IT, deliberately: the admin has just
 * named that exact address and chosen a holder for it, which is the same
 * explicit act that issued it in the first place. What it does NOT do is
 * resurrect the OLD holders -- see UN-RETIRE IS A TEARDOWN below.
 *
 * UN-RETIRE IS A TEARDOWN, AND STARTS FROM NO HOLDERS. Retirement keeps the
 * grant rows (revokeSendingIdentity explains why: they are the record of who
 * used to hold the address, and the screen shows them). Clearing revokedAt
 * without touching them therefore used to hand the address back to EVERY
 * historical holder at once, so issuing a retired address to one new person
 * silently restored all the old ones. That breaks the one rule this whole
 * feature is built on -- an admin saying no once must not be undone by an
 * unrelated action -- because the admin re-minting an address for Carol is not
 * saying anything at all about Alice and Bob.
 *
 * So the grants are deleted here, INSIDE the same transaction that clears the
 * flag, and the caller's target is then the only holder. Coming back from
 * retirement costs the admin one explicit re-grant per person, which is the
 * point: each one is a decision, and the audit log carries both halves (the
 * `sending_identity.revoke` row, and this call's `before.clearedGrants`).
 *
 * Both directions of that rule are load-bearing, and the two doc comments now
 * agree with the code and with each other:
 *   - retire  -> grants SURVIVE, so the screen can say who used to hold it;
 *   - unretire -> grants are CLEARED, so nobody returns without being re-named.
 *
 * ONE TRANSACTION, AND THIS IS THE CRITICAL PART. The un-retire and the grant
 * create used to be two separate writes. When the create failed -- P2002 for a
 * holder the row already lists, which is the most natural click available since
 * the screen still shows a retired address's holders -- the un-retire had
 * already committed, recordAudit sat below the throw, and the admin saw a
 * refusal. Net effect: the retired address was live again for every stale
 * holder, with zero audit rows. Wrapping both writes plus the audit row makes
 * the refusal mean what it says.
 *
 * Note on catching inside a transaction: every catch below RETHROWS. That is
 * what keeps it safe. Postgres aborts the whole transaction the instant a
 * statement fails, so catching one and then continuing to issue more statements
 * on the same connection fails with "current transaction is aborted" (or worse,
 * silently converts the COMMIT to a ROLLBACK). Translating an error and
 * rethrowing is fine; recovering from one in place is not.
 */
export async function issueSendingIdentity(
  actorPersonId: string | null,
  input: { address: string; displayName?: string | null } & SendingIdentityTarget,
): Promise<IssuedIdentityView> {
  const address = normalizeSendingAddress(input.address);
  if (!address) throw new SenderIdentityError("Enter an email address.");
  assertSignable(address, (await connectedGraphMailbox()).account);
  const displayName = input.displayName?.trim() ? input.displayName.trim() : null;
  const target: SendingIdentityTarget =
    "personId" in input ? { personId: input.personId } : { roleId: input.roleId };

  const identityId = await prisma.$transaction(async (tx) => {
    // Read BEFORE the upsert clears the flag: afterwards there is no way to tell
    // an un-retire from an ordinary second holder being added.
    const before = await tx.sendingIdentity.findUnique({
      where: { address },
      select: { revokedAt: true },
    });
    const wasRetired = before?.revokedAt != null;

    const row = await tx.sendingIdentity.upsert({
      where: { address },
      create: { address, displayName, createdById: actorPersonId },
      update: {
        // ONLY when one was actually supplied. The display name is a property of
        // the ADDRESS now, and this form is how a SECOND holder gets added, so an
        // unconditional write means adding a role to an existing address silently
        // erases the name recipients have been seeing -- with the blank optional
        // field on the form reading as "erase it" rather than "I did not set one".
        // Caught by driving the page, not by tsc, eslint, or any test that existed
        // at the time. Same distinction identityData draws for a scope's identity
        // columns. Clearing a display name is not something this screen offered
        // before the split either.
        ...(displayName ? { displayName } : {}),
        revokedAt: null,
        revokedById: null,
      },
    });

    // The teardown. Only on the un-retire path: adding a second holder to a LIVE
    // address must obviously leave the first one alone.
    let clearedGrants: Array<{ personId: string | null; roleId: string | null }> = [];
    if (wasRetired) {
      clearedGrants = await tx.sendingIdentityGrant.findMany({
        where: { identityId: row.id },
        select: { personId: true, roleId: true },
      });
      await tx.sendingIdentityGrant.deleteMany({ where: { identityId: row.id } });
    }

    // The shipped UI builds its person and role options from the full roster with
    // no exclusion of who already holds a grant, and a stale detail page (or a
    // genuine double click) can also race two identical submits, so this
    // unique-constraint violation (SendingIdentityGrant_unique_grant) is one
    // click away in normal use rather than an edge case. Translate it into this
    // module's typed error, exactly as grantScope does, instead of letting a raw
    // P2002 reach the generic error boundary.
    //
    // Unreachable on the un-retire path now, because the deleteMany above just
    // emptied the table for this identity. It stays for the live-address case.
    try {
      await tx.sendingIdentityGrant.create({
        data: { identityId: row.id, ...target, grantedById: actorPersonId },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new SenderIdentityError(
          `That person or role can already send as "${address}".`,
        );
      }
      // A stale page naming a person or role that has since been deleted. Same
      // treatment for the same reason: a typed refusal the page can render,
      // rather than a raw P2003 at the generic error boundary. Before the
      // transaction this one also left the address un-retired behind it.
      if (isForeignKeyConstraintError(err)) {
        throw new SenderIdentityError(
          "That person or role no longer exists. Reload and choose another.",
        );
      }
      throw err;
    }

    // Recorded on the TRANSACTION client, so the trail cannot go missing while
    // the write it describes survives -- which is exactly what went wrong.
    await recordAudit(
      {
        actorPersonId,
        action: "sending_identity.issue",
        entityType: "SendingIdentity",
        entityId: row.id,
        // Only on an un-retire, where it is the whole history of the address:
        // who held it before the retirement, and that they no longer do.
        ...(wasRetired ? { before: { revoked: true, clearedGrants } } : {}),
        after: { address: row.address, displayName: row.displayName, ...target },
      },
      tx,
    );

    return row.id;
  });

  return loadIssuedIdentity(identityId);
}

/**
 * Retire an ADDRESS. Idempotent: retiring a retired one changes nothing.
 *
 * This is the revocation with the auditable trail, and the one that has to kill
 * EVERY route to the address. It does that by flipping one flag on the row every
 * route passes through, rather than by deleting grants: a delete would be
 * undone by the next grant anyone adds, and would leave no record that the
 * address was ever retired.
 *
 * THE GRANTS SURVIVE, and the screen shows them as history ("Previously held
 * by"). They confer nothing while the flag is set -- every read filters on
 * revokedAt at the identity, which is the whole reason the flag lives there --
 * so keeping them costs no authority and buys the record of who used to hold it.
 *
 * They do NOT come back. issueSendingIdentity deletes them when it clears the
 * flag, so re-minting the address for one person cannot quietly restore the
 * others. That pairing is the contract: retire keeps them, un-retire clears
 * them, and neither doc comment is true without the other.
 */
export async function revokeSendingIdentity(
  actorPersonId: string | null,
  id: string,
): Promise<void> {
  const existing = await prisma.sendingIdentity.findUnique({ where: { id } });
  if (!existing) throw new SenderIdentityError("That sending identity no longer exists.");
  if (existing.revokedAt) return;

  await prisma.sendingIdentity.update({
    where: { id },
    data: { revokedAt: new Date(), revokedById: actorPersonId },
  });

  await recordAudit({
    actorPersonId,
    action: "sending_identity.revoke",
    entityType: "SendingIdentity",
    entityId: id,
    before: { address: existing.address },
  });
}

/**
 * Take one address away from one holder, leaving it live for the others.
 *
 * A DELETE, not a flag, and the trail is this audit row -- the same call
 * revokeScope makes for an AudienceScopeGrant. Keeping it a delete is what lets
 * the COALESCE unique index stay a plain unique (a retired grant row would
 * collide with the re-grant), and it keeps the number of nullable revocation
 * filters a read can forget at exactly one, on SendingIdentity.
 */
export async function revokeSendingIdentityGrant(
  actorPersonId: string | null,
  grantId: string,
): Promise<void> {
  // Same shape as issueSendingIdentity's P2002 handling, for the double-submit
  // and stale-page P2025 case (the grant was already removed in another tab).
  let grant;
  try {
    grant = await prisma.sendingIdentityGrant.delete({ where: { id: grantId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new SenderIdentityError("That grant no longer exists.");
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "sending_identity.revoke_grant",
    entityType: "SendingIdentity",
    entityId: grant.identityId,
    before: { personId: grant.personId, roleId: grant.roleId },
  });
}

type IssuedRow = {
  id: string;
  address: string;
  displayName: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  grants: Array<{
    id: string;
    personId: string | null;
    roleId: string | null;
    grantedAt: Date;
    person: { name: string } | null;
    role: { name: string } | null;
  }>;
};

const ISSUED_INCLUDE = {
  grants: {
    include: { person: { select: { name: true } }, role: { select: { name: true } } },
    orderBy: [{ grantedAt: "asc" }, { id: "asc" }],
  },
} as const satisfies Prisma.SendingIdentityInclude;

/**
 * `graphMailbox` is threaded in rather than read here because this runs per ROW
 * while the credential is one row for the whole list. It is required for the
 * same reason sendingAddressProblem's is: the Transport column this fills is
 * rendered beside SenderIdentityNotes, which does consult the mailbox, and the
 * two printing different transports for one address is what happened when it
 * did not.
 */
function toIssuedView(row: IssuedRow, graphMailbox: string | null): IssuedIdentityView {
  return {
    id: row.id,
    address: row.address,
    displayName: row.displayName,
    // Read live rather than snapshotted, so an admin can SEE that a previously
    // fine identity stopped being signable when the allowlist narrowed.
    transport: signingTransportFor(row.address, graphMailbox),
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    grants: row.grants.map((g) => ({
      id: g.id,
      personId: g.personId,
      roleId: g.roleId,
      // The XOR constraint guarantees one of the two, so the fallback is
      // unreachable rather than a real state; it exists so a row written before
      // that constraint (or by a future migration that forgets it) renders as
      // something an admin can see and delete instead of crashing the screen.
      targetName: g.person?.name ?? g.role?.name ?? "(no target)",
      kind: g.personId ? "person" : "role",
      grantedAt: g.grantedAt,
    })),
  };
}

async function loadIssuedIdentity(id: string): Promise<IssuedIdentityView> {
  const row = await prisma.sendingIdentity.findUniqueOrThrow({
    where: { id },
    include: ISSUED_INCLUDE,
  });
  return toIssuedView(row, (await connectedGraphMailbox()).account);
}

/**
 * Every issued address for the admin screen, retired ones included.
 *
 * Retired rows are shown deliberately: they are the record of an address the
 * clinic once spoke as, and hiding them would make a revoke look like a delete
 * on a screen whose whole job is to explain who holds what.
 */
export async function listIssuedIdentities(): Promise<IssuedIdentityView[]> {
  const [rows, mailbox] = await Promise.all([
    prisma.sendingIdentity.findMany({
      include: ISSUED_INCLUDE,
      orderBy: { address: "asc" },
    }),
    // Once for the whole list, not once per row.
    connectedGraphMailbox(),
  ]);
  return rows.map((row) => toIssuedView(row, mailbox.account));
}

// ---------------------------------------------------------------------------
// Issuing a person their OWN address, as an admin act
// ---------------------------------------------------------------------------

/**
 * The outcome of offering a person their own profile address as an identity.
 *
 * A REASON rather than a throw for every expected refusal, because the two
 * callers want opposite things from one. The scope-grant hook discards it: the
 * identity is a bonus and an email problem must not fail a permission grant. The
 * identities page shows it, so an admin whose click did nothing learns whether
 * the person has no address, an unsignable one, or one that was deliberately
 * taken away. A throw would force the first caller to swallow what the second
 * one needs.
 */
export type OwnAddressResult =
  | { issued: true; identity: IssuedIdentityView }
  | { issued: false; reason: string };

/** What stops this person's own address becoming an identity, or the address. */
type OwnAddressCheck = { ok: true; address: string } | { ok: false; reason: string };

/**
 * Read the person's CURRENT profile address and say whether it may be issued.
 *
 * The three refusals, in the order they are cheap to answer:
 *
 *   NO ADDRESS. Nothing to issue. Not an error anywhere.
 *   UNSIGNABLE. Same `sendingAddressProblem` every other write seam applies, so
 *     personal Gmail (the common case) never becomes an identity that would fail
 *     after the sender hit Send.
 *   ALREADY RETIRED, and this is the one that matters. An admin revoked that
 *     address; the flag is the record of a refusal. A later scope grant is a
 *     decision about an AUDIENCE and is not a reversal of it, so this path never
 *     clears revokedAt -- unlike issueSendingIdentity, where clearing it is
 *     correct precisely because the admin has just typed that exact address and
 *     chosen a holder for it. Re-issuing a retired address stays an explicit,
 *     deliberate act on the identities form and is not something a grant does
 *     for you.
 */
async function checkOwnAddress(
  personId: string,
  approvedAddress?: string,
): Promise<OwnAddressCheck> {
  const row = await prisma.person.findUnique({
    where: { id: personId },
    select: { contactEmail: true, status: true },
  });
  if (!row) return { ok: false, reason: "That person no longer exists." };

  // ONLY AN ACTIVE PERSON. Both shipped callers already filter to ACTIVE (the
  // grant form's roster, and peopleWithAnyPermission behind the gap list), so
  // reaching this needs a hand-crafted POST -- which is precisely why it is
  // checked here. This module's stated posture is that the page is not the
  // enforcement point, and offboarding is supposed to take away the right to
  // speak as the clinic, not leave it one request away. Same direction as
  // offboard convergence: OFFBOARDED means the claims stop.
  if (row.status !== "ACTIVE") {
    return {
      ok: false,
      reason: "That person is not active, so no address can be issued to them.",
    };
  }

  const address = normalizeSendingAddress(row.contactEmail);
  if (!address) {
    return { ok: false, reason: "No contact email on file, so there is no address to issue." };
  }

  // THE ADDRESS THE ADMIN APPROVED MUST STILL BE THE ADDRESS ON FILE.
  //
  // Without this the printed address is decoration. Everything that makes this
  // mechanism safe rests on a human having READ the specific string before
  // approving it, and contactEmail is self-service: the person can edit it
  // between the screen rendering "Also issues sender@..." and the admin
  // clicking. That window is short, but the prize is an unclaimed clinic role
  // address on a Maileroo-signed domain, which is exactly the escalation review
  // round 1 closed. Comparing normalized values makes the approval name a
  // specific string rather than "whatever is in the field when the click lands".
  //
  // A mismatch REFUSES rather than issuing the new value: the admin has not
  // seen it. They reload, read the new address, and decide again.
  if (approvedAddress !== undefined && approvedAddress !== address) {
    return {
      ok: false,
      reason:
        `Their contact address is now "${address}", not the "${approvedAddress}" this page ` +
        `showed. Nothing was issued. Reload and check the new address before approving it.`,
    };
  }

  const problem = sendingAddressProblem(address, (await connectedGraphMailbox()).account);
  if (problem) return { ok: false, reason: problem };

  const existing = await prisma.sendingIdentity.findUnique({
    where: { address },
    select: { revokedAt: true },
  });
  if (existing?.revokedAt) {
    return {
      ok: false,
      reason:
        `"${address}" was revoked by an admin, so it is not re-issued automatically. ` +
        `Issue it explicitly above if that revocation was a mistake.`,
    };
  }
  return { ok: true, address };
}

/**
 * Issue a person the address currently on their profile, if an admin may.
 *
 * THIS IS THE MECHANISM THAT GIVES BACK THE CONVENIENCE TASK 2 REMOVED, and the
 * one line worth understanding about it is that the address is READ ONCE, HERE,
 * and SNAPSHOTTED into a SendingIdentity row. Every later read goes through that
 * row, so editing the profile afterwards changes nothing about what the person
 * may send as. The removed layer read contactEmail at RESOLVE time, which is why
 * it reduced to "whatever I just typed"; nothing in this module resolves against
 * that field, and nothing may start. See the module note.
 *
 * What makes the snapshot legitimate is that an ADMIN takes it, having SEEN the
 * exact address: this is called from a person-targeted scope grant and from an
 * explicit click on the identities page, both gated on outreach.manage_scopes,
 * and both attribute the row to the admin rather than to the sender.
 *
 * `approvedAddress` IS REQUIRED, AND IT IS THE WHOLE SECURITY ARGUMENT. It is
 * the string the caller displayed, checked against the person's current
 * contactEmail before anything is written (see checkOwnAddress). Two things fall
 * out of making it mandatory rather than optional, and both matter:
 *
 *   Nothing can auto-issue an address a human never read. A caller that has not
 *   shown the address to anybody has nothing to pass, so it cannot reach this
 *   function at all -- rather than reaching it and quietly conferring whatever
 *   is in the field. The failure mode of forgetting is a compile error.
 *
 *   It is still NEVER a way to name an arbitrary address. The parameter can only
 *   MATCH or REFUSE; it is never written. The set of issuable addresses is
 *   exactly {their current contactEmail}, which is what "no inference, no
 *   widening" means here.
 *
 * IDEMPOTENT in every direction a real click reaches:
 *   - the address already exists (a shared mailbox, or a previous grant): the
 *     row is reused and a grant is added beside the others;
 *   - this person already holds it, directly: the duplicate-grant P2002 is
 *     caught and reported as success, because success is what it describes;
 *   - the address was retired: refused, see checkOwnAddress.
 *
 * The upsert's empty `update` is what makes the create race-safe without giving
 * anything away: if a concurrent write minted the row between the check above
 * and here, this touches nothing -- in particular it does not clear revokedAt,
 * which is the difference between this and issueSendingIdentity. The result is
 * re-checked for revocation afterwards for the same reason.
 */
export async function issueOwnAddress(
  actorPersonId: string | null,
  personId: string,
  /** The address the admin was shown and approved. Matched, never written. */
  approvedAddress: string,
): Promise<OwnAddressResult> {
  const approved = normalizeSendingAddress(approvedAddress);
  if (!approved) return { issued: false, reason: "No address was approved." };
  const check = await checkOwnAddress(personId, approved);
  if (!check.ok) return { issued: false, reason: check.reason };
  const { address } = check;

  const row = await prisma.sendingIdentity.upsert({
    where: { address },
    create: { address, createdById: actorPersonId },
    update: {},
  });
  // Only reachable when a concurrent revoke landed between the check and the
  // upsert. Refused rather than granted: a retired address stays retired.
  if (row.revokedAt) {
    return {
      issued: false,
      reason: `"${address}" was revoked by an admin, so it is not re-issued automatically.`,
    };
  }

  try {
    await prisma.sendingIdentityGrant.create({
      data: { identityId: row.id, personId, grantedById: actorPersonId },
    });
  } catch (err) {
    // They already hold it. That is the outcome asked for, so it is a success,
    // not a second failure mode on the same click.
    if (!isUniqueConstraintError(err)) throw err;
    return { issued: true, identity: await loadIssuedIdentity(row.id) };
  }

  await recordAudit({
    actorPersonId,
    action: "sending_identity.issue_own",
    entityType: "SendingIdentity",
    entityId: row.id,
    after: { address: row.address, personId },
  });

  return { issued: true, identity: await loadIssuedIdentity(row.id) };
}

/**
 * One sentence per person saying what granting them a scope does to their
 * sending identity, for the grant form to print beside the button.
 *
 * THE POINT IS THE ADDRESS ITSELF, spelled out before the click. What
 * issueOwnAddress snapshots comes from a self-service profile field, so the only
 * thing standing between an approval and "whatever that person last typed" is an
 * admin having read this string. An auto-issue the granting admin never saw
 * would be the old hole with an extra step, so the screens print it and this is
 * the function they print.
 *
 * Batched into ONE identity query rather than a per-person lookup: the roster on
 * that form is every ACTIVE person, and the form re-renders on every save.
 */
export type AutoIssuePreview = {
  /** The sentence to print beside the control. */
  note: string;
  /**
   * How loudly to print it. STRUCTURED, not sniffed out of the text.
   *
   * The grant form used to pick its critical styling with
   * `note.startsWith("WARNING:")`, which tied a styling decision to a prose
   * string nothing pinned: a copy edit would silently downgrade the impostor
   * note to muted with no test failing. Severity is decided here, where the
   * facts are, and the form branches on it.
   */
  severity: "info" | "warning";
  /**
   * The address a grant would issue, or null when it would issue nothing --
   * including when this person ALREADY holds it directly, where there is nothing
   * to approve and the grant is just a grant. The screen submits this back as
   * grantScope's `approvedAddress`, so it is what the admin is approving rather
   * than merely being shown.
   */
  issuableAddress: string | null;
};

/**
 * THE ONE OWNERSHIP CAUTION, written once and shown on EVERY issuable branch.
 *
 * It used to appear only when the address was new, which put the mildest copy on
 * the strongest attack. The dangerous case is the opposite one: the address is
 * ALREADY a live clinic identity held by somebody real, a member has typed that
 * same string into their own profile, and the grant quietly makes them a second
 * holder of it. Both branches now carry this, and the already-held branch also
 * names who holds it, because "already held by Real Director" is the sentence
 * that actually stops the click.
 */
const OWNERSHIP_CAUTION =
  "This address comes from their own profile, which they can edit themselves, so confirm it really belongs to them before granting.";

/** One grant on a queried address, keeping enough to tell whose it is. */
type KnownGrant = { personId: string | null; roleId: string | null; label: string };
type KnownAddress = { revoked: boolean; grants: KnownGrant[] };

/** Live holders of each queried address, for the warnings above. */
async function knownAddresses(addresses: string[]): Promise<Map<string, KnownAddress>> {
  const known = addresses.length
    ? await prisma.sendingIdentity.findMany({
        where: { address: { in: addresses } },
        select: {
          address: true,
          revokedAt: true,
          // One extra include on a query already being made. Without the names
          // the warning is "somebody else holds this", which is not actionable;
          // without the ids it cannot tell "somebody else" from "you".
          grants: {
            select: {
              personId: true,
              roleId: true,
              person: { select: { name: true } },
              role: { select: { name: true } },
            },
          },
        },
      })
    : [];

  const map = new Map<string, KnownAddress>();
  for (const row of known) {
    map.set(row.address, {
      revoked: row.revokedAt !== null,
      grants: row.grants.map((g) => ({
        personId: g.personId,
        roleId: g.roleId,
        label: g.person
          ? g.person.name
          : g.role
            ? `everyone with the ${g.role.name} role`
            : "someone",
      })),
    });
  }
  return map;
}

/**
 * Split an address's holders into "this person" and "everybody else".
 *
 * WHY THE SPLIT EXISTS. The warning it feeds is "someone else already holds
 * this", and an unfiltered holder list makes that sentence name the very person
 * being previewed: a sender who already holds their own address saw the full
 * impostor warning, in the critical style, citing themselves as the existing
 * holder. That is not an exotic state -- the one-click gap fixer on
 * /outreach/identities produces it for every sender it helps -- so it would have
 * been the COMMON case, and a warning that fires on the common case stops being
 * a warning. Same failure the gap list's own "leaves caution null when nobody
 * else holds the address" test already guards against.
 *
 * BOTH ROUTES COUNT AS THEIRS: a direct grant, and a grant to a role they hold.
 * roleIdsForPerson is called only when the address actually carries a role
 * grant, which on this screen's roster is almost never, so the full-roster
 * preview stays one query in the ordinary case.
 */
async function holderSplit(
  entry: KnownAddress | undefined,
  personId: string,
): Promise<{ others: string[]; theirsDirectly: boolean }> {
  if (!entry || entry.grants.length === 0) return { others: [], theirsDirectly: false };

  const theirsDirectly = entry.grants.some((g) => g.personId === personId);
  const roleGrants = entry.grants.filter((g) => g.roleId !== null);
  const theirRoleIds = roleGrants.length ? new Set(await roleIdsForPerson(personId)) : new Set();

  const others = entry.grants
    .filter((g) => {
      // Currently unobservable, and kept anyway. Every caller short-circuits on
      // theirsDirectly before reading `others`, so a mutation that deletes this
      // line kills no test -- the ROLE line below is the one with teeth. It
      // stays because `others` has to mean what its name says on its own terms:
      // the next caller to want the list without the early return should not
      // have to discover that it silently includes the person they asked about.
      if (g.personId === personId) return false;
      if (g.roleId !== null && theirRoleIds.has(g.roleId)) return false;
      return true;
    })
    .map((g) => g.label);

  return { others, theirsDirectly };
}

/** "A", "A and B", "A, B and C", or null when the list is empty. */
function holderPhrase(holders: string[]): string | null {
  if (holders.length === 0) return null;
  if (holders.length === 1) return holders[0];
  return `${holders.slice(0, -1).join(", ")} and ${holders[holders.length - 1]}`;
}

export async function describeAutoIssue(
  people: Array<{ id: string; contactEmail: string | null }>,
): Promise<Map<string, AutoIssuePreview>> {
  const addresses = [
    ...new Set(
      people
        .map((p) => normalizeSendingAddress(p.contactEmail))
        .filter((a): a is string => a !== null),
    ),
  ];
  const known = await knownAddresses(addresses);
  // Once for the whole roster, not once per person. Every signability answer in
  // this loop has to be the one the send path would give, and the connected
  // mailbox is part of that answer.
  const { account: graphMailbox } = await connectedGraphMailbox();

  const notes = new Map<string, AutoIssuePreview>();
  for (const p of people) {
    const address = normalizeSendingAddress(p.contactEmail);
    if (!address) {
      notes.set(p.id, {
        severity: "info",
        issuableAddress: null,
        note: "No contact email on file, so no sending identity is issued. The scope grant still goes through.",
      });
      continue;
    }
    const existing = known.get(address);
    if (existing?.revoked) {
      notes.set(p.id, {
        severity: "info",
        issuableAddress: null,
        note: `${address} was revoked by an admin, so this grant will NOT re-issue it. Issue it again below if that revocation was a mistake.`,
      });
      continue;
    }
    const problem = sendingAddressProblem(address, graphMailbox);
    if (problem) {
      notes.set(p.id, {
        severity: "info",
        issuableAddress: null,
        note: `${problem} No sending identity is issued. The scope grant still goes through.`,
      });
      continue;
    }

    const { others, theirsDirectly } = await holderSplit(existing, p.id);

    // ALREADY THEIRS. Nothing to approve and nothing to issue, so the button
    // stays a plain "Grant" and no approvedAddress is submitted. This is the
    // state the one-click gap fixer leaves every sender in, so it is the branch
    // most rows on a real roster land in.
    if (theirsDirectly) {
      notes.set(p.id, {
        severity: "info",
        issuableAddress: null,
        note: `${address} is already issued to them, and stays issued. This grant only adds the scope.`,
      });
      continue;
    }

    // Issuable. Offered even when SOMEBODY ELSE already holds the address: the
    // grant then adds this person as another holder, which is a real change and
    // the one most worth approving deliberately.
    const heldBy = holderPhrase(others);
    notes.set(p.id, {
      severity: heldBy ? "warning" : "info",
      issuableAddress: address,
      note: heldBy
        ? `${address} is ALREADY a sending identity, held by ${heldBy}. Granting adds this person as another holder of it. ${OWNERSHIP_CAUTION}`
        : `Also issues ${address} as a sending identity, so they can send campaigns from it. ${OWNERSHIP_CAUTION}`,
    });
  }
  return notes;
}

/** A person who may send campaigns but has no address to send them from. */
export type SenderMissingIdentity = {
  personId: string;
  name: string;
  /** Their current profile address, normalized, or null when they have none. */
  address: string | null;
  /** Why the one-click issue cannot help them, or null when it can. */
  blocker: string | null;
  /**
   * A reason to look harder before clicking, when the click IS available.
   *
   * Distinct from `blocker` on purpose: a blocker means the button cannot work
   * and is not rendered, this means it would work and might be exactly wrong.
   * Today it is the impostor shape -- their profile address is already a live
   * clinic identity somebody else holds -- which without this rendered as a bare
   * "Issue directors@..." button, the mildest possible copy on the strongest
   * attack. Adding a second holder to a shared mailbox is also a legitimate act,
   * so this warns and names the holders rather than refusing.
   */
  caution: string | null;
};

/**
 * The permissions that make somebody a SENDER, and therefore someone who needs a
 * From address. Deliberately not outreach.manage_scopes: an admin who issues
 * identities is not thereby a sender, and listing them would turn the gap list
 * into a roster nobody reads.
 */
const SENDING_PERMISSIONS = ["outreach.send", "outreach.send_unrestricted"];

/**
 * Senders holding no active identity, so the gap is VISIBLE and one click wide.
 *
 * Auto-issue on a person-targeted scope grant structurally misses two real
 * populations, and both of them are the review's actual complaint rather than an
 * edge case:
 *
 *   outreach.send_unrestricted holders need no scope grant at all, so no
 *   person-targeted outreach event ever happens for them. Before this list they
 *   had zero From options and no page on which to fix it.
 *
 *   A sender whose scope arrived through a ROLE grant, for the same reason a
 *   role grant issues nothing: the grant named the role, not them.
 *
 * "Has an identity" is asked through availableSenderIdentities with a null
 * scope, which is the SAME function the compose menu and the authorization check
 * use. Asking it any other way (reading the grants table directly, say) would be
 * a second definition of "may send as", and the first thing it would get wrong
 * is role expansion -- which is exactly the population this list exists for.
 *
 * One pair of queries per candidate. The candidate set is the clinic's outreach
 * senders, which is a handful of people, and correctness here is worth more than
 * a hand-rolled join that could disagree with the resolver.
 */
export async function sendersWithoutIdentity(): Promise<SenderMissingIdentity[]> {
  const senders = await peopleWithAnyPermission(SENDING_PERMISSIONS);

  const missing: SenderMissingIdentity[] = [];
  for (const sender of senders) {
    const options = await availableSenderIdentities(sender.id, null);
    if (options.length > 0) continue;
    const check = await checkOwnAddress(sender.id);
    missing.push({
      personId: sender.id,
      name: sender.name,
      address: normalizeSendingAddress(sender.contactEmail),
      blocker: check.ok ? null : check.reason,
      caution: null,
    });
  }

  // The already-someone-else's signal, same shape the grant form carries. Asked
  // once for the whole list rather than per row: the gap list is short, but this
  // keeps it one query regardless. checkOwnAddress deliberately does NOT treat
  // this as a blocker -- a shared mailbox reaching a second person is the
  // feature -- so it rides alongside as a caution.
  const issuable = missing
    .filter((m) => m.blocker === null && m.address !== null)
    .map((m) => m.address as string);
  if (issuable.length === 0) return missing;

  const known = await knownAddresses([...new Set(issuable)]);
  for (const row of missing) {
    if (row.blocker !== null || row.address === null) continue;
    // Filtered through the same holderSplit the grant form uses, so "someone
    // else holds this" has one definition. It is a no-op HERE by construction --
    // every row in this list resolved to zero identities, so neither route can
    // reach them -- but going through the shared helper is what stops the two
    // screens drifting apart the next time one of them changes.
    const { others } = await holderSplit(known.get(row.address), row.personId);
    const heldBy = holderPhrase(others);
    if (heldBy) {
      row.caution =
        `${row.address} is ALREADY a sending identity, held by ${heldBy}. ` +
        `Issuing it here adds ${row.name} as another holder. ${OWNERSHIP_CAUTION}`;
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Resolution and authorization
// ---------------------------------------------------------------------------

/**
 * Every address this person may send as under this scope, strongest claim first.
 *
 * This is BOTH the menu the compose UI offers and the set authorization checks
 * against; they are the same list on purpose, so an address can never be offered
 * that would then be refused, nor refused that was offered.
 *
 * `personId` is nullable because the enqueue-time re-resolve can reach here with
 * no surviving chooser. The scope layer does not depend on a person, so it still
 * resolves; the issued layer simply contributes nothing.
 *
 * ROLE EXPANSION HAPPENS HERE AND NOWHERE ELSE, which is what keeps the menu and
 * the check one list. The compose UI, the save-time authorization check, and the
 * enqueue-time re-resolve all reach this function; none of them expands roles
 * itself, and none of them caches the answer. So "the identities you may send
 * as" is a single live query in a single place, and a role removed a second ago
 * is gone from all three at once.
 */
export async function availableSenderIdentities(
  personId: string | null,
  scope: ScopeIdentity | null,
): Promise<SenderIdentityOption[]> {
  const options: SenderIdentityOption[] = [];
  const seen = new Set<string>();
  // The connected mailbox, once for the whole resolve. Without it this function
  // dropped the one address Graph can ALWAYS send as, which on the clinic's real
  // state (a mailbox on a subdomain, which does not inherit its parent's
  // allowlist row) meant the compose menu refused an address the send path would
  // have carried perfectly well.
  const { account: graphMailbox } = await connectedGraphMailbox();

  const add = (
    address: string | null,
    displayName: string | null,
    source: SenderIdentitySource,
  ): void => {
    if (!address || seen.has(address)) return;
    // The same gate both write seams apply, re-applied on the way out. A row
    // written before this check existed, or one whose domain has since left the
    // allowlist, contributes nothing rather than contributing something that
    // would fail at send or be silently rewritten by the pinned fallback.
    if (sendingAddressProblem(address, graphMailbox)) return;
    // Non-null: sendingAddressProblem just cleared it.
    const transport = signingTransportFor(address, graphMailbox) as SigningTransport;
    seen.add(address);
    options.push({ address, displayName, source, transport });
  };

  // 1. The scope identity. Strongest: an admin set it on the delegation boundary.
  //
  // KNOWN AND DELIBERATE, RECORDED HERE BECAUSE IT SURPRISES PEOPLE: this layer
  // never consults SendingIdentity at all, so "Revoke address" on
  // /outreach/identities does NOT stop a scope whose fromEmail is that same
  // address from sending as it. The two layers are independent admin-controlled
  // channels -- retiring an ISSUED address retires the issued route, and the
  // scope's own identity is retired by clearing it on the scope -- and an admin
  // who sets both has made two decisions, not one.
  //
  // The defence is that both ends are admin-only, so nothing here escalates: a
  // delegated sender cannot reach an address this way that an admin did not put
  // on their scope. But an admin clicking "Revoke address" plausibly reads it as
  // "nobody sends as this any more", and for a scope identity it is not. Left as
  // is (pre-existing since Task 2, and collapsing the layers would make one
  // screen silently edit another); flagged so the next person to wonder finds
  // the answer next to the code rather than by experiment.
  add(normalizeSendingAddress(scope?.fromEmail), scope?.fromName ?? null, "scope");

  // 2. Addresses issued to this person -- DIRECTLY, or to a role they hold --
  // and THE LAST LAYER. There is deliberately no third layer reading
  // Person.contactEmail: see the module note for why a self-service unverified
  // field cannot be a claim, and do not re-add it as a convenience.
  //
  // Two things about this one query are load-bearing:
  //
  //   `revokedAt: null` sits on the IDENTITY, outside the grants filter, so it
  //   is not a condition a grant can satisfy its way around. A retired address
  //   is gone through the direct route and the role route at once, which is why
  //   the flag lives on this table and not on the grants.
  //
  //   roleIdsForPerson is the SAME helper scopesForPerson uses (rbac/engine),
  //   not a second expansion, so "which roles does this person hold" has one
  //   definition. It reads live DB state, so a role removed between two REQUESTS
  //   is absent from the second with nothing to invalidate.
  //
  //   BETWEEN two requests, not two calls, and the difference is bigger than it
  //   sounds. roleIdsForPerson is wrapped in React cache(), which memoizes per
  //   REQUEST, so every call for one person inside one request returns the same
  //   answer. The longest such request is not a page render: /api/cron/email
  //   declares maxDuration = 300 and dispatchDueCampaigns loops every due
  //   campaign inside it, so somebody who is fromEmailSetById on several
  //   campaigns has their role set computed once and reused for the whole drain
  //   -- up to five minutes, not the sub-second window a page render suggests.
  //
  //   Left exactly as it is, deliberately. Reading roles uncached here would
  //   create the second expansion path this design exists to forbid, and
  //   scopesForPerson carries the identical property, so the two would have to
  //   diverge together or not at all. The exposure is bounded and acceptable: a
  //   role removed mid-drain is honored on the NEXT drain, and everything the
  //   stale set can still reach is an address an admin issued to a role that
  //   person held when the request began.
  if (personId) {
    const roleIds = await roleIdsForPerson(personId);
    const issued = await prisma.sendingIdentity.findMany({
      where: {
        revokedAt: null,
        grants: {
          some: {
            OR: [{ personId }, ...(roleIds.length ? [{ roleId: { in: roleIds } }] : [])],
          },
        },
      },
      orderBy: { address: "asc" },
    });
    for (const row of issued) add(row.address, row.displayName, "issued");
  }

  return options;
}

/**
 * The identity a campaign should send as, refusing anything unauthorized.
 *
 * `requested` null (or blank) means "take the default", which is the strongest
 * claim available. A non-blank `requested` is checked against the same list the
 * UI offers, and anything absent from it is refused -- including a real,
 * admin-configured address belonging to a scope this campaign is not bound to.
 *
 * Refusal is a throw, never a silent downgrade to the default: a sender who
 * asked to send as one address and got another would have no way to notice.
 */
export async function resolveSenderIdentity(
  personId: string | null,
  scope: ScopeIdentity | null,
  requested: string | null | undefined,
): Promise<SenderIdentityOption | null> {
  const options = await availableSenderIdentities(personId, scope);
  const wanted = normalizeSendingAddress(requested);
  if (!wanted) return options[0] ?? null;

  const match = options.find((o) => o.address === wanted);
  if (!match) {
    throw new SenderIdentityError(
      `You may not send as "${wanted}". Choose one of the identities offered, ` +
        `or ask an admin to issue that address to you.`,
    );
  }
  return match;
}

/**
 * The identity one campaign RUN sends as, re-resolved at enqueue time.
 *
 * Re-resolved rather than trusted, for the same reason assertMayActOnScope
 * re-checks on every call: a campaign can be composed under one set of claims
 * and dispatched under another, and a recurring campaign is dispatched by cron
 * with no actor at all, weeks later. TWO events of the same class have to be
 * caught here, and both are, because both travel one code path:
 *
 *   - the identity was RETIRED between Save and Send, and
 *   - the chooser LOST THE ROLE the grant reached them through.
 *
 * The second needs no code of its own: availableSenderIdentities expands roles
 * live on every call, so a stored choice that only a lost role justified is
 * simply not in the list this function searches.
 *
 * A stored choice that no longer resolves FALLS BACK down the order rather than
 * failing the run. The fallback is drawn from THAT SAME freshly-resolved list,
 * so it can only ever be something the chooser could still pick at this moment:
 * it lands on the scope identity or the global default, both admin-controlled.
 * The failure mode is a campaign that goes out from a safe address rather than a
 * recurring campaign that silently stops. The swap is logged by the caller,
 * which is the only place that knows which campaign it was.
 */
export async function resolveCampaignSender(
  campaign: { fromEmail: string | null; fromEmailSetById: string | null },
  scope: ScopeIdentity | null,
): Promise<{ identity: SenderIdentityOption | null; honoredChoice: boolean }> {
  const options = await availableSenderIdentities(campaign.fromEmailSetById, scope);
  const wanted = normalizeSendingAddress(campaign.fromEmail);
  if (!wanted) return { identity: options[0] ?? null, honoredChoice: true };

  const match = options.find((o) => o.address === wanted);
  if (match) return { identity: match, honoredChoice: true };
  return { identity: options[0] ?? null, honoredChoice: false };
}

/**
 * The display name one send goes out under, beside the address.
 *
 * THE ORDER: an admin-set name, then the sending PERSON's name, then the
 * ORGANISATION's, then nothing.
 *
 * AN ADMIN-SET NAME WINS; THE SENDING PERSON'S NAME FILLS THE GAP. Both layers
 * of the resolution order carry an admin-set name -- a scope's `fromName` and an
 * issued identity's `displayName`, both already folded into
 * SenderIdentityOption.displayName by the time they reach here -- and both mean
 * the same thing: somebody decided this address speaks in an institutional
 * voice. `recruitment@havenfreeclinic.org` configured as "HAVEN Recruitment"
 * keeps that voice whoever pressed Send. Only where nobody made that decision
 * does the person show through, which is what turns a bare
 * `j.carney@yale.edu` into `Jack Carney <j.carney@yale.edu>`.
 *
 * WHICH PERSON is the caller's decision and it is not the obvious one. For a
 * campaign it is the person who CHOSE the identity
 * (EmailCampaign.fromEmailSetById), not the actor dispatching the run: a
 * recurring campaign is dispatched by cron with no actor at all, weeks after
 * composition, so crediting the dispatcher would credit nobody exactly when it
 * matters. See senderForRun.
 *
 * `personId` IS ALLOWED TO NAME NOBODY, and that is not an error. A campaign
 * with no explicit identity has no chooser to begin with, and
 * `fromEmailSetById` is SetNull on delete, so a departed chooser arrives here as
 * null. Read with findUnique rather than findUniqueOrThrow for the same reason:
 * an id that no longer resolves must degrade rather than throw. The name is
 * COSMETIC and plays no part in DKIM or SPF alignment (see transport.ts), so
 * losing it costs a line of polish while throwing would fail the whole run.
 *
 * AND UNDER BOTH, THE ORGANISATION'S OWN NAME. Nobody-chose is the ordinary
 * case, not the exotic one: every campaign in production takes the default
 * identity, so the person layer fires on none of them and they would all still
 * go out bare. orgDisplayName is the floor, and it records why the campaign's
 * CREATOR is deliberately not one -- do not add that fallback here either.
 * Blank all the way down still means no name, never a blank one.
 *
 * RESOLVED AT ENQUEUE, and snapshotted onto EmailLog.fromName there, exactly
 * like the address. The drain re-reads that row verbatim minutes or hours later,
 * so resolving at delivery time would let a rename retroactively rewrite the
 * From of mail already accepted.
 */
export async function senderDisplayName(
  identity: { displayName: string | null } | null | undefined,
  personId: string | null | undefined,
): Promise<string | null> {
  const configured = identity?.displayName?.trim();
  if (configured) return configured;
  if (personId) {
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { name: true },
    });
    const chooser = person?.name.trim();
    if (chooser) return chooser;
  }
  return orgDisplayName();
}

/**
 * The From one SENDER TEST goes out as: the address, and the name a real send
 * from that address would carry.
 *
 * sendSenderTest exists to mirror what the drain does with the same From, so a
 * test message arriving under a different name would stop showing what
 * recipients actually see -- the one check that confirms an address is usable
 * would be reporting on a message production never sends. The precedence is
 * therefore senderDisplayName's, unchanged: the identity's admin-set name, then
 * the admin running the test, who here IS the sending person.
 *
 * THE ADDRESS IS RESOLVED FROM AN ID, and the row is re-read with
 * `revokedAt: null` rather than trusted from the caller. The button on
 * /outreach/identities renders only on an active row, so resolving a revoked one
 * would leave the server not enforcing what the screen implies -- and it would
 * be the one read of an identity on that page that skips the revocation filter,
 * which is exactly the shape the whole revocation risk is about. Null means
 * there is nothing to test.
 */
export async function senderTestFrom(
  identityId: string,
  actorPersonId: string,
): Promise<{ fromEmail: string; fromName: string | null } | null> {
  const identity = await prisma.sendingIdentity.findFirst({
    where: { id: identityId.trim(), revokedAt: null },
    select: { address: true, displayName: true },
  });
  if (!identity) return null;
  return {
    fromEmail: identity.address,
    fromName: await senderDisplayName(identity, actorPersonId),
  };
}
