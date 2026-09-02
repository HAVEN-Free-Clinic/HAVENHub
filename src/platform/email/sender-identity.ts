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
 * THE COST, accepted deliberately, and wider than "delegated senders lose a
 * convenience": nobody can send as anything but an admin-issued address or their
 * campaign's scope identity. That binds an outreach.send_unrestricted holder
 * too, not only a scoped one. The two permissions are separate in
 * platform/modules/registry.ts, so a person who may send to anyone but does not
 * hold outreach.manage_scopes gets ZERO From options and no page on which to
 * grant themselves one: their campaigns go out from whatever the campaign sender
 * rules resolve to until somebody with manage_scopes issues them an address.
 * That is the intended shape (issuing is an admin act, and self-issue is exactly
 * what would make the check circular), but it is a real operational dependency
 * rather than a papercut for scoped senders alone.
 *
 * A STALE COMMENT, deliberately not corrected in place: migration
 * 20260902140000_sending_identity's header still describes the removed layer as
 * current, because Prisma checksums applied migrations and a comment-only edit
 * to an applied one breaks `migrate deploy` and `migrate status`. This module is
 * the authority on the order; that header is not.
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
 * expansion -- on every call, and nothing stores the answer. So losing a role
 * loses the identity on the very next resolve, with no save and no refresh in
 * between, and because resolveCampaignSender goes through this one function, the
 * enqueue-time re-resolve re-expands roles for free. Role loss between Save and
 * Send is the same class of event as a revocation between Save and Send, and it
 * gets the same treatment because it travels the same code path.
 */
import { Prisma } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { roleIdsForPerson } from "@/platform/rbac/engine";
import { signingTransportFor, type SigningTransport } from "./sending-domains";
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
 * Lowercasing is what makes the (personId, address) unique constraint behave
 * case-insensitively without a raw-SQL expression index, which a later
 * `prisma migrate diff` would propose DROPping. It is also what makes an
 * authorization comparison case-blind in the safe direction: a differently-cased
 * request matches a held address, and no casing turns an unheld one into a held
 * one.
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
 * Exposed as a reason rather than only as a throw so that the scope editor --
 * which reports its refusals as ScopeValidationError, not as this module's error
 * type -- can reuse exactly this check instead of writing a second one.
 */
export function sendingAddressProblem(address: string | null | undefined): string | null {
  const normalized = normalizeSendingAddress(address);
  if (!normalized) return "Enter an email address.";
  if (!EMAIL_RE.test(normalized)) return `"${normalized}" is not a valid email address.`;
  if (signingTransportFor(normalized)) return null;
  return (
    `"${normalized}" is not on a verified sending domain, so no transport can sign for it. ` +
    `Use an address on a domain listed in SENDING_DOMAINS.`
  );
}

/** The transport that can sign for a usable address, or a refusal. */
export function assertSignable(address: string): SigningTransport {
  const reason = sendingAddressProblem(address);
  if (reason) throw new SenderIdentityError(reason);
  // Non-null: sendingAddressProblem returned null precisely because this did not.
  return signingTransportFor(address) as SigningTransport;
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
 * resurrect the OLD holders -- their grants had to be deleted for the retirement
 * to mean anything, and they are not recreated here.
 */
export async function issueSendingIdentity(
  actorPersonId: string | null,
  input: { address: string; displayName?: string | null } & SendingIdentityTarget,
): Promise<IssuedIdentityView> {
  const address = normalizeSendingAddress(input.address);
  if (!address) throw new SenderIdentityError("Enter an email address.");
  assertSignable(address);
  const displayName = input.displayName?.trim() ? input.displayName.trim() : null;
  const target: SendingIdentityTarget =
    "personId" in input ? { personId: input.personId } : { roleId: input.roleId };

  const row = await prisma.sendingIdentity.upsert({
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

  // The shipped UI builds its person and role options from the full roster with
  // no exclusion of who already holds a grant, and a stale page (or a genuine
  // double click) can also race two identical submits, so this unique-constraint
  // violation (SendingIdentityGrant_unique_grant) is one click away in normal
  // use rather than an edge case. Translate it into this module's typed error,
  // exactly as grantScope does, instead of letting a raw P2002 reach the generic
  // error boundary.
  try {
    await prisma.sendingIdentityGrant.create({
      data: { identityId: row.id, ...target, grantedById: actorPersonId },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new SenderIdentityError(
        `That person or role can already send as "${address}".`,
      );
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "sending_identity.issue",
    entityType: "SendingIdentity",
    entityId: row.id,
    after: { address: row.address, displayName: row.displayName, ...target },
  });

  return loadIssuedIdentity(row.id);
}

/**
 * Retire an ADDRESS. Idempotent: retiring a retired one changes nothing.
 *
 * This is the revocation with the auditable trail, and the one that has to kill
 * EVERY route to the address. It does that by flipping one flag on the row every
 * route passes through, rather than by deleting grants: a delete would be
 * undone by the next grant anyone adds, and would leave no record that the
 * address was ever retired. The grants are deliberately left in place, so the
 * admin screen can still say who used to hold it.
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

function toIssuedView(row: IssuedRow): IssuedIdentityView {
  return {
    id: row.id,
    address: row.address,
    displayName: row.displayName,
    // Read live rather than snapshotted, so an admin can SEE that a previously
    // fine identity stopped being signable when the allowlist narrowed.
    transport: signingTransportFor(row.address),
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
  return toIssuedView(row);
}

/**
 * Every issued address for the admin screen, retired ones included.
 *
 * Retired rows are shown deliberately: they are the record of an address the
 * clinic once spoke as, and hiding them would make a revoke look like a delete
 * on a screen whose whole job is to explain who holds what.
 */
export async function listIssuedIdentities(): Promise<IssuedIdentityView[]> {
  const rows = await prisma.sendingIdentity.findMany({
    include: ISSUED_INCLUDE,
    orderBy: { address: "asc" },
  });
  return rows.map(toIssuedView);
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
    if (sendingAddressProblem(address)) return;
    // Non-null: sendingAddressProblem just cleared it.
    const transport = signingTransportFor(address) as SigningTransport;
    seen.add(address);
    options.push({ address, displayName, source, transport });
  };

  // 1. The scope identity. Strongest: an admin set it on the delegation boundary.
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
  //   definition. It reads live DB state, so a role removed between two calls
  //   is absent from the second with nothing to invalidate.
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
