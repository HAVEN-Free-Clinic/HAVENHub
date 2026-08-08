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
import { createPass, isWalletEnabled, revokePass, type PassInput } from "./wallet-client";

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
