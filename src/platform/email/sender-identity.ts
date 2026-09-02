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
 * THE ORDER, strongest claim first:
 *
 *   1. The campaign's SCOPE identity (AudienceScope.fromEmail / fromName). An
 *      admin set it on the delegation boundary itself, so it is the strongest
 *      claim available and outranks anything the sender holds personally.
 *   2. An address explicitly ISSUED to the sender (SendingIdentity). This is the
 *      delegatable half: an admin hands a specific person a specific address.
 *   3. The sender's own Person.contactEmail, because it is theirs.
 *
 *   ...then null, meaning the caller falls through to the existing per-template
 *   and per-category sender rules and finally the global email.sender setting.
 *
 * NOT IN THE ORDER: anything the sender types at compose time that is not one of
 * the three above. The compose UI offers a choice AMONG the resolved identities;
 * it does not accept a free-text address, and resolveSenderIdentity refuses one.
 *
 * EVERY LAYER IS FILTERED THROUGH THE ALLOWLIST, and layers 1 and 2 are also
 * validated when they are WRITTEN. Rejecting at write is the point: an identity
 * nothing can sign is a campaign that fails after the sender has already hit
 * Send. Layer 3 has no write seam here -- Person.contactEmail is a contact
 * address, written by the people admin and by members on /my-info, and it would
 * be wrong to make the allowlist a constraint on someone's contact details. So
 * that layer is filtered at read time instead, which is why an unlisted
 * contactEmail is neither offered nor accepted rather than being offered and
 * then silently rewritten to the pinned global sender by MailerooTransport.
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

/** A refusal: an address nobody can sign, or one this person may not use. */
export class SenderIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderIdentityError";
  }
}

/** Which layer of the order a resolved identity came from. */
export type SenderIdentitySource = "scope" | "issued" | "own";

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
 * Asks signingTransportFor and nothing else. No consumer in this module names a
 * domain, so re-enabling Maileroo's yale.edu entry stays the one-line change
 * sending-domains.ts documents.
 *
 * Exposed as a reason rather than only as a throw so that the scope editor --
 * which reports its refusals as ScopeValidationError, not as this module's error
 * type -- can reuse exactly this check instead of writing a second one.
 */
export function unsignableReason(address: string | null | undefined): string | null {
  const normalized = normalizeSendingAddress(address);
  if (!normalized) return "Enter an email address.";
  if (signingTransportFor(normalized)) return null;
  return (
    `"${normalized}" is not on a verified sending domain, so no transport can sign for it. ` +
    `Use an address on a domain listed in SENDING_DOMAINS.`
  );
}

/** The transport that can sign for this address, or a refusal. */
export function assertSignable(address: string): SigningTransport {
  const reason = unsignableReason(address);
  if (reason) throw new SenderIdentityError(reason);
  // Non-null: unsignableReason returned null precisely because this did not.
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
    // The allowlist filter every layer passes through. A layer whose address the
    // allowlist does not carry contributes nothing rather than contributing
    // something that would be silently rewritten at send.
    const transport = signingTransportFor(address);
    if (!transport) return;
    seen.add(address);
    options.push({ address, displayName, source, transport });
  };

  // 1. The scope identity. Strongest: an admin set it on the delegation boundary.
  add(normalizeSendingAddress(scope?.fromEmail), scope?.fromName ?? null, "scope");

  if (personId) {
    // 2. Addresses issued to this person. revokedAt: null is the whole check --
    // a presence-only lookup here is the ServiceCredential bug.
    const issued = await prisma.sendingIdentity.findMany({
      where: { personId, revokedAt: null },
      orderBy: { address: "asc" },
    });
    for (const row of issued) add(row.address, row.displayName, "issued");

    // 3. Their own contact address, which is always theirs.
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { contactEmail: true, name: true },
    });
    add(normalizeSendingAddress(person?.contactEmail), person?.name ?? null, "own");
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
