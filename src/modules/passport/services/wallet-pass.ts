/**
 * Term-scoped wallet badges.
 *
 * The badge asserts PRESENT standing, so it is scoped to the member's current
 * term, expires at term end without anyone acting, and is revoked on offboard.
 * The cumulative story (member since, every term served) deliberately lives on
 * the certificate and the credential page instead: a badge that outlived a
 * member's standing would let a former volunteer carry a plausible clinic
 * credential indefinitely.
 */

import { randomUUID } from "node:crypto";
import { isUniqueConstraintError, prisma } from "@/platform/db";
import { log } from "@/platform/logging";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { computeServiceRecord } from "./service-record";
import { todayMarker } from "./term-day";
import { brandingDataUri } from "./wallet-branding";
import { autoPublishForBadge } from "./credential";
import {
  createPass,
  isWalletEnabled,
  revokePass,
  updatePass,
  type PassInput,
} from "./wallet-client";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Vendor accepts 1 to 3650. Clamp so a mis-set term end can never send an invalid value. */
function expirationDays(endDate: Date): number {
  const days = Math.ceil((endDate.getTime() - Date.now()) / DAY_MS);
  return Math.min(3650, Math.max(1, days));
}

/**
 * Shorten a service record's `memberSince.label` for a wallet field.
 *
 * A membership-derived label is already a term name ("Spring 2026"), but a
 * RECRUITMENT-derived one is the cycle label ("Fall 2023 Volunteer
 * Recruitment"), which overflows a secondary field on a card. Strip the
 * recruitment boilerplate and keep the season and year.
 */
export function shortenSince(label: string): string {
  const seasonYear = label.match(/\b(Spring|Summer|Fall|Autumn|Winter)\s+(\d{4})\b/i);
  if (seasonYear) return `${seasonYear[1]} ${seasonYear[2]}`;
  const year = label.match(/\b(\d{4})\b/);
  if (year) return year[1];
  return label;
}

/**
 * What a successful issue hands back: the two install links, plus the credential
 * token the badge's QR now points at.
 *
 * publicToken is returned because adding a badge AUTO-PUBLISHES the credential
 * (see autoPublishForBadge). Before audit 14 the caller was told nothing about
 * that, so /my-info kept rendering "Publish a shareable link" and hid the
 * Unpublish control until a full reload, leaving the member no way to undo a
 * publish that had already happened. Null means nothing was published: the
 * member previously unpublished, or the credential is revoked.
 */
export type WalletPassIssue = {
  googleSaveUrl: string;
  shareUrl: string;
  publicToken: string | null;
};

/**
 * A serial that names no vendor pass, written while a create is in flight so the
 * (personId, termId) unique index acts as the lock. Prefixed rather than opaque
 * so a row in this state is recognisable in the database, and random so two
 * claims can never collide.
 *
 * A pending row left behind by a request that died mid-create heals itself: the
 * next issue refreshes that serial, the vendor answers 404, and the GONE branch
 * below retires the row and mints a replacement.
 */
function pendingSerial(): string {
  return `pending_${randomUUID()}`;
}

/**
 * Take exclusive ownership of this person's badge slot for this term, returning
 * the placeholder serial that proves ownership, or null when someone else got
 * there first.
 *
 * Why a claim at all: two overlapping "Add to wallet" calls both found no live
 * row, both called createPass, and the second upsert overwrote serialNumber with
 * its own. The first serial was then referenced by nothing, so neither
 * revokeWalletPasses nor the sweep could reach it and a live, scannable badge
 * survived every revoke path the app has (audit 14).
 *
 * Both branches are atomic claims in the codebase's established shape: a
 * conditional write that selects and flips state in the SAME statement. The
 * updateMany revives a revoked row only if it is still revoked (a concurrent
 * caller that revived it first leaves count 0), and the insert leans on the
 * (personId, termId) unique index, so the loser gets P2002 rather than a second
 * vendor pass.
 */
async function claimIssueSlot(personId: string, termId: string): Promise<string | null> {
  const claim = pendingSerial();

  const revived = await prisma.walletPass.updateMany({
    where: { personId, termId, revokedAt: { not: null } },
    // The install URLs are cleared with the serial: they belong to the pass this
    // row used to name, and handing them back for a different serial would send
    // a member to install a badge nothing in this table can revoke.
    data: {
      serialNumber: claim,
      revokedAt: null,
      issuedAt: new Date(),
      googleSaveUrl: null,
      shareUrl: null,
    },
  });
  if (revived.count === 1) return claim;

  try {
    await prisma.walletPass.create({ data: { personId, termId, serialNumber: claim } });
    return claim;
  } catch (error) {
    // P2002 on (personId, termId) means a concurrent call holds the slot, or a
    // live row appeared between the read above and now. Either way this call must
    // NOT mint: the other one already has, or is about to.
    if (isUniqueConstraintError(error)) return null;
    throw error;
  }
}

/**
 * Undo a claim the vendor never honoured. Scoped to the placeholder serial so
 * this can never delete a row that names a real pass, and a delete (rather than
 * a revoke) is what restores the pre-claim state: the row it may have replaced
 * was already revoked, meaning its serial was already deleted at the vendor.
 */
async function releaseIssueSlot(personId: string, termId: string, claim: string): Promise<void> {
  await prisma.walletPass.deleteMany({ where: { personId, termId, serialNumber: claim } });
}

export async function issueWalletPass(personId: string): Promise<WalletPassIssue | null> {
  if (!isWalletEnabled()) return null;

  const term = await getActiveTerm();
  if (!term) return null;

  // getActiveTerm filters on status alone and ignores endDate, and this clinic
  // runs a documented window where a term has ENDED but has not been flipped to
  // ARCHIVED yet. Without this guard a member could resurrect, in that window,
  // exactly the badge the reconciliation sweep just revoked for having an ended
  // term (see wallet-sweep.ts). The badge asserts PRESENT standing, so a term
  // that is over cannot back one.
  //
  // Compared as a CALENDAR DAY, not an instant: endDate is a noon-UTC marker, so
  // `< Date.now()` refused to issue a badge from 08:00 ET on the term's final
  // clinic day, which is a day members are still on shift (audit 14). See
  // term-day.ts.
  if (term.endDate.getTime() < (await todayMarker()).getTime()) return null;

  // Ordered, and the senior role wins, because a member can hold SEVERAL ACTIVE
  // memberships in one term: the unique key is (person, term, department, kind),
  // so a director who also volunteers in another department has two rows. The
  // old findFirst took whatever Postgres returned first, so a director's badge
  // could read "Volunteer" and name the wrong department, and could say something
  // different after an unrelated write reordered the heap (audit 14). DIRECTOR
  // beats VOLUNTEER for the same reason it does on the certificate (see
  // computeServiceRecord), and department code breaks the remaining tie.
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId: term.id, status: "ACTIVE" },
    select: {
      kind: true,
      department: { select: { name: true, code: true } },
      // The badge is an identification card, so it has to name its holder.
      // netId is nullable: non-Yale members are matched by contact email and
      // never given one (see the non-Yale member login rules), so it is only
      // rendered when present.
      person: { select: { name: true, netId: true } },
    },
    orderBy: { department: { code: "asc" } },
  });
  const membership = memberships.find((m) => m.kind === "DIRECTOR") ?? memberships[0];
  if (!membership) return null;

  // The badge is present-tense, so it carries only the since-year, never a
  // cumulative shift total. The full history lives on the certificate and the
  // credential page, which are the artifacts that survive offboarding.
  const record = await computeServiceRecord(personId);
  const [orgName, brandColor, baseUrl, logoUri, iconUri, stripUri] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSetting<string>("branding.brandColor"),
    getSetting<string>("app.baseUrl"),
    brandingDataUri("logo"),
    brandingDataUri("favicon"),
    brandingDataUri("strip"),
  ]);

  // The QR resolves to the member's published credential page, which is the only
  // thing worth scanning: a page a third party can actually check.
  //
  // Adding a badge auto-publishes (see autoPublishForBadge), so every badge
  // carries a QR without the member hunting for a separate toggle. It respects a
  // prior unpublish and a revoked credential, both of which yield null and a
  // badge with no barcode rather than one pointing at a 404.
  const token = await autoPublishForBadge(personId);
  const credentialUrl = token ? `${baseUrl}/credential/${token}` : null;
  const barcodeValue = credentialUrl;

  const role = membership.kind === "DIRECTOR" ? "Director" : "Volunteer";

  // The NAME takes the primary slot, which is the large line on the card. An
  // identification badge whose most prominent field was the holder's role told
  // you what they do and never who they are; the first real card issued had no
  // name on it anywhere.
  const primaryFields = [{ key: "name", label: "Name", value: membership.person.name }];

  const secondaryFields = [
    { key: "role", label: "Role", value: role },
    // The CODE, not the name. A card issued with the full name rendered
    // "Information Technology and Communications" shrunk to fit beside two other
    // fields; the code is what members say aloud anyway. The full name still
    // appears on the certificate and the credential page, which have room.
    { key: "department", label: "Department", value: membership.department.code },
    { key: "term", label: "Term", value: term.name },
  ];

  // The back holds what supports a lookup rather than a glance. netId lives here
  // rather than on the face: it identifies the member in Yale's systems, it is
  // not needed to recognise someone standing in front of you, and the front of a
  // badge is the surface most likely to be read over a shoulder or photographed.
  const backFields = [
    ...(membership.person.netId
      ? [{ key: "netid", label: "NetID", value: membership.person.netId }]
      : []),
    ...(record.memberSince
      ? [
          {
            key: "since",
            label: "Member since",
            value: shortenSince(record.memberSince.label),
          },
        ]
      : []),
    { key: "department-full", label: "Department", value: membership.department.name },
    // The same target the QR encodes, in text, so the badge is still verifiable
    // by someone who cannot scan it.
    ...(credentialUrl ? [{ key: "verify", label: "Verify", value: credentialUrl }] : []),
  ];

  const input: PassInput = {
    organizationName: orgName,
    // Short by necessity: this sits in a narrow strip beside a wide logo, and
    // "Director Identification" truncated to "Director Iden..." on a real card.
    // The logo image already carries the org name and the ROLE field is directly
    // below, so this only needs to say which kind of badge it is.
    logoText: `${role} ID`,
    description: `${orgName} ${role.toLowerCase()} badge`,
    expirationDays: expirationDays(term.endDate),
    primaryFields,
    secondaryFields,
    backFields,
    barcodeValue,
    // Pro-tier only; wallet-client drops these when the trial has lapsed.
    // Data URIs, NOT URLs: the vendor fetches a URL from its own infrastructure
    // and cannot reach this host, which returned a hard 400 in production
    // ("logoURL could not be fetched"). See wallet-branding.ts. Either image
    // resolving to null just means the pass issues without it.
    brandColor,
    logoUrl: logoUri ?? undefined,
    iconUrl: iconUri ?? undefined,
    stripUrl: stripUri ?? undefined,
  };

  // Re-issue REFRESHES the live pass in place instead of minting a second one.
  // Creating again would overwrite this row's serialNumber, and the old serial
  // would then be referenced by nothing: neither revokeWalletPasses nor
  // sweepWalletPasses can reach a serial that is not in the table, so an
  // offboarded member would keep a live, scannable badge until term end. The
  // free tier also counts creations, and /my-info re-offers "Add to wallet" on
  // every reload, so this path is hit repeatedly by design.
  //
  // A REVOKED row is deliberately not reused: its serial is already deleted at
  // the vendor, so there is nothing to orphan and nothing to refresh.
  const existing = await prisma.walletPass.findUnique({
    where: { personId_termId: { personId, termId: term.id } },
    select: {
      id: true,
      serialNumber: true,
      revokedAt: true,
      googleSaveUrl: true,
      shareUrl: true,
    },
  });

  if (existing && !existing.revokedAt) {
    const refreshed = await updatePass(existing.serialNumber, input);

    // The vendor does not have this pass: it was revoked or deleted there, so
    // our row is stale. Without this the member is stuck forever, because every
    // click refreshes a serial that no longer exists (seen in production on
    // 2026-08-10 after a pass was revoked vendor-side). Retire the row and fall
    // through to create a replacement.
    //
    // This is the ONLY failure that earns a fallback to createPass. A 404 is
    // unambiguous, so a replacement cannot orphan a live pass; an ambiguous
    // failure (timeout, 500) might leave one behind that nothing could revoke.
    if (refreshed === "GONE") {
      await prisma.walletPass.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      log.info("[passport] wallet pass was gone at the vendor, reissuing", {
        passId: existing.id,
      });
    } else {
      // No fallback to createPass on failure: a duplicate we cannot revoke is
      // worse than no badge on this click. The member retries, or the pass they
      // already installed keeps working until it expires at term end.
      if (!refreshed) return null;
      await prisma.walletPass.update({
        where: { id: existing.id },
        data: { issuedAt: new Date() },
      });
      // The install links come from the ROW, not the refresh response: a PUT
      // returns only an acknowledgement (see RefreshResult). A row written
      // before those columns existed has neither, so there is nothing to hand
      // back and the caller renders the same "not available" state as a vendor
      // failure; the pass the member already installed is untouched and still
      // refreshed.
      if (!existing.googleSaveUrl || !existing.shareUrl) {
        log.error("[passport] refreshed a pass with no stored install URLs", {
          passId: existing.id,
        });
        return null;
      }
      // The stored serial is deliberately NOT rewritten from the response: this
      // row's serial is the only handle revocation has, and it is what the pass
      // the member already installed was issued under.
      return {
        googleSaveUrl: existing.googleSaveUrl,
        shareUrl: existing.shareUrl,
        publicToken: token,
      };
    }
  }

  // Claim BEFORE minting. Nothing between here and the write below may mint a
  // second vendor pass for this (person, term): see claimIssueSlot.
  const claim = await claimIssueSlot(personId, term.id);
  if (!claim) {
    // The other caller is minting the badge this member asked for. Returning
    // null renders the card's calm "not available right now" state, and the
    // next click picks up the pass the winner created.
    log.info("[passport] a wallet issue is already in flight, not minting a second pass", {
      personId,
      termId: term.id,
    });
    return null;
  }

  const created = await createPass(input);
  if (!created) {
    await releaseIssueSlot(personId, term.id, claim);
    return null;
  }

  // update, not upsert: the claim row is ours and no concurrent caller can hold
  // it, so there is no second row for this (person, term) to reconcile with.
  await prisma.walletPass.update({
    where: { personId_termId: { personId, termId: term.id } },
    data: {
      serialNumber: created.serialNumber,
      googleSaveUrl: created.googleSaveUrl,
      shareUrl: created.shareUrl,
      issuedAt: new Date(),
      revokedAt: null,
    },
  });

  return {
    googleSaveUrl: created.googleSaveUrl,
    shareUrl: created.shareUrl,
    publicToken: token,
  };
}

/**
 * Revoke every live badge for a person. Returns how many were confirmed revoked
 * at the vendor. A failed vendor call deliberately leaves revokedAt null so the
 * reconciliation sweep retries: a badge we believe is dead but is not would be
 * worse than one we retry.
 */
export async function revokeWalletPasses(personId: string): Promise<number> {
  if (!isWalletEnabled()) return 0;

  const passes = await prisma.walletPass.findMany({
    where: { personId, revokedAt: null },
    select: { id: true, serialNumber: true },
  });

  let revoked = 0;
  for (const pass of passes) {
    const ok = await revokePass(pass.serialNumber);
    if (!ok) {
      log.error("[passport] wallet revoke failed, leaving for the sweep", { passId: pass.id });
      continue;
    }
    await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
    revoked += 1;
  }
  return revoked;
}
