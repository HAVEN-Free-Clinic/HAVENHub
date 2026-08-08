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

import { prisma } from "@/platform/db";
import { log } from "@/platform/logging";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { computeServiceRecord } from "./service-record";
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

export async function issueWalletPass(
  personId: string,
): Promise<{ googleSaveUrl: string; shareUrl: string } | null> {
  if (!isWalletEnabled()) return null;

  const term = await getActiveTerm();
  if (!term) return null;

  // getActiveTerm filters on status alone and ignores endDate, and this clinic
  // runs a documented window where a term has ENDED but has not been flipped to
  // ARCHIVED yet. Without this guard a member could resurrect, in that window,
  // exactly the badge the reconciliation sweep just revoked for having an ended
  // term (see wallet-sweep.ts). The badge asserts PRESENT standing, so a term
  // that is over cannot back one.
  if (term.endDate.getTime() < Date.now()) return null;

  const membership = await prisma.termMembership.findFirst({
    where: { personId, termId: term.id, status: "ACTIVE" },
    select: { kind: true, department: { select: { name: true } } },
  });
  if (!membership) return null;

  // The badge is present-tense, so it carries only the since-year, never a
  // cumulative shift total. The full history lives on the certificate and the
  // credential page, which are the artifacts that survive offboarding.
  const record = await computeServiceRecord(personId);
  // Only the org name is read: custom color and logo are Pro-tier features, and
  // the free tier takes a colorPreset (set in wallet-client.ts).
  const orgName = await getSetting<string>("branding.orgName");

  const role = membership.kind === "DIRECTOR" ? "Director" : "Volunteer";
  const secondaryFields = [
    { key: "department", label: "Department", value: membership.department.name },
    { key: "term", label: "Term", value: term.name },
  ];
  if (record.memberSince) {
    secondaryFields.push({
      key: "since",
      label: "Member since",
      value: record.memberSince.label,
    });
  }

  const input: PassInput = {
    organizationName: orgName,
    logoText: orgName,
    description: `${role} badge`,
    expirationDays: expirationDays(term.endDate),
    primaryFields: [{ key: "role", label: "Role", value: role }],
    secondaryFields,
    barcodeValue: null,
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
    select: { id: true, serialNumber: true, revokedAt: true },
  });

  if (existing && !existing.revokedAt) {
    const refreshed = await updatePass(existing.serialNumber, input);
    // No fallback to createPass on failure: a duplicate we cannot revoke is
    // worse than no badge on this click. The member retries, or the pass they
    // already installed keeps working until it expires at term end.
    if (!refreshed) return null;
    await prisma.walletPass.update({
      where: { id: existing.id },
      data: { issuedAt: new Date() },
    });
    // The stored serial is deliberately NOT rewritten from the response: this
    // row's serial is the only handle revocation has, and it is what the pass
    // the member already installed was issued under.
    return { googleSaveUrl: refreshed.googleSaveUrl, shareUrl: refreshed.shareUrl };
  }

  const created = await createPass(input);
  if (!created) return null;

  await prisma.walletPass.upsert({
    where: { personId_termId: { personId, termId: term.id } },
    create: { personId, termId: term.id, serialNumber: created.serialNumber },
    update: { serialNumber: created.serialNumber, issuedAt: new Date(), revokedAt: null },
  });

  return { googleSaveUrl: created.googleSaveUrl, shareUrl: created.shareUrl };
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
