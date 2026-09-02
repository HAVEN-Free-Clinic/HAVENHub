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
 * an admin-set scope identity, and from nowhere else. The cost is real and was
 * accepted deliberately: a delegated sender now needs an address issued to them
 * before they can send as anything but their campaign's scope identity.
 *
 * EVERY LAYER IS VALIDATED WHEN IT IS WRITTEN, and filtered again when it is
 * read. Rejecting at write is the point: an identity nothing can sign is a
 * campaign that fails after the sender has already hit Send. Filtering again at
 * read covers a row written before a check existed, or one whose domain left the
 * allowlist afterwards.
 *
 * REVOCATION IS A FLIP, NOT A DELETE. SendingIdentity.revokedAt is the sole
 * validity signal and every read here filters on it. ServiceCredential shipped
 * exactly the opposite bug -- a presence-only relation check counted a revoked
 * credential as held (see the hasServiceCredential note in
 * audience/person-fields.ts) -- and the same shape would be worse here, because
 * the thing it wrongly grants is the right to speak as the clinic.
 */
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
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

/** An issued row as the admin screen shows it, revoked ones included. */
export type IssuedIdentityView = {
  id: string;
  personId: string;
  personName: string;
  address: string;
  displayName: string | null;
  transport: SigningTransport | null;
  issuedAt: Date;
  revokedAt: Date | null;
};

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
 * Issue an address to a person, or restore one previously revoked.
 *
 * Upsert on the (personId, address) pair rather than insert, because revocation
 * flips revokedAt on the row instead of deleting it: a second insert for the
 * same pair would violate the constraint, so re-issuing has to clear the flag in
 * place. That is the same shape restoreServiceCredential already uses.
 */
export async function issueSendingIdentity(
  actorPersonId: string | null,
  input: { personId: string; address: string; displayName?: string | null },
): Promise<IssuedIdentityView> {
  const address = normalizeSendingAddress(input.address);
  if (!address) throw new SenderIdentityError("Enter an email address.");
  const transport = assertSignable(address);
  const displayName = input.displayName?.trim() ? input.displayName.trim() : null;

  const row = await prisma.sendingIdentity.upsert({
    where: { personId_address: { personId: input.personId, address } },
    create: {
      personId: input.personId,
      address,
      displayName,
      issuedById: actorPersonId,
    },
    update: {
      displayName,
      issuedById: actorPersonId,
      issuedAt: new Date(),
      revokedAt: null,
      revokedById: null,
    },
    include: { person: { select: { name: true } } },
  });

  await recordAudit({
    actorPersonId,
    action: "sending_identity.issue",
    entityType: "SendingIdentity",
    entityId: row.id,
    after: { personId: row.personId, address: row.address, displayName: row.displayName },
  });

  return { ...toIssuedView(row), transport };
}

/** Revoke an issued address. Idempotent: revoking a revoked row changes nothing. */
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
    before: { personId: existing.personId, address: existing.address },
  });
}

type IssuedRow = {
  id: string;
  personId: string;
  address: string;
  displayName: string | null;
  issuedAt: Date;
  revokedAt: Date | null;
  person: { name: string };
};

function toIssuedView(row: IssuedRow): IssuedIdentityView {
  return {
    id: row.id,
    personId: row.personId,
    personName: row.person.name,
    address: row.address,
    displayName: row.displayName,
    // Read live rather than snapshotted, so an admin can SEE that a previously
    // fine identity stopped being signable when the allowlist narrowed.
    transport: signingTransportFor(row.address),
    issuedAt: row.issuedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Every issued row for the admin screen, revoked ones included.
 *
 * Revoked rows are shown deliberately: they are the record of who used to be
 * able to speak as the clinic, and hiding them would make a revoke look like a
 * delete on a screen whose whole job is to explain who holds what.
 */
export async function listIssuedIdentities(): Promise<IssuedIdentityView[]> {
  const rows = await prisma.sendingIdentity.findMany({
    include: { person: { select: { name: true } } },
    orderBy: [{ person: { name: "asc" } }, { address: "asc" }],
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
 * resolves; the other two simply contribute nothing.
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

  // 2. Addresses issued to this person, and THE LAST LAYER. revokedAt: null is
  // the whole validity check -- a presence-only lookup here is the
  // ServiceCredential bug. There is deliberately no third layer reading
  // Person.contactEmail: see the module note for why a self-service unverified
  // field cannot be a claim, and do not re-add it as a convenience.
  if (personId) {
    const issued = await prisma.sendingIdentity.findMany({
      where: { personId, revokedAt: null },
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
 * with no actor at all, weeks later. Specifically, an issued identity revoked
 * between Save and Send must stop being used.
 *
 * A stored choice that no longer resolves FALLS BACK down the order rather than
 * failing the run. The fallback lands on the scope identity or the global
 * default, both of which are admin-controlled, so the failure mode is a campaign
 * that goes out from a safe address rather than a recurring campaign that
 * silently stops. The swap is logged by the caller, which is the only place that
 * knows which campaign it was.
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
