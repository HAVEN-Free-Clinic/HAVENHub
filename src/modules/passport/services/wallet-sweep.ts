/**
 * Reconciliation for wallet badges.
 *
 * The vendor has no webhooks and no status endpoint, and every revoke path in
 * the app is best-effort, so nothing else guarantees a badge actually dies. This
 * sweep is that guarantee: it re-revokes anything whose term has ended, whose
 * person has been offboarded, or whose person no longer holds a place here, and
 * it is safe to run repeatedly because vendor deletes are documented no-ops.
 */

import { prisma } from "@/platform/db";
import { log } from "@/platform/logging";
import { OFFBOARDABLE_TERM } from "@/platform/people";
import { todayMarker } from "./term-day";
import { isWalletEnabled, revokePass } from "./wallet-client";

export async function sweepWalletPasses(): Promise<{ revoked: number; failed: number }> {
  if (!isWalletEnabled()) return { revoked: 0, failed: 0 };

  const today = await todayMarker();

  const stale = await prisma.walletPass.findMany({
    where: {
      revokedAt: null,
      OR: [
        // A CALENDAR-day comparison, not an instant one: endDate is a noon-UTC
        // marker, so `lt: new Date()` made every badge for a term ending today
        // sweepable from 08:00 ET onwards, killing badges in the middle of the
        // term's final clinic day (audit 14). See term-day.ts.
        { term: { endDate: { lt: today } } },
        { person: { status: "OFFBOARDED" } },
        // The badge asserts PRESENT standing, and Person.status alone does not
        // express it: withdrawFromTerm and a mid-term roster removal both flip
        // memberships to REMOVED while leaving Person.status ACTIVE, so before
        // audit 14 a member who quit in week 2 kept a scannable badge claiming
        // current standing until the term ended.
        //
        // OFFBOARDABLE_TERM is the same non-archived scope offboarding uses to
        // answer "does this person still have a place here" -- shared, not
        // re-spelled, because the two must not drift apart.
        { person: { memberships: { none: { status: "ACTIVE", ...OFFBOARDABLE_TERM } } } },
      ],
    },
    select: { id: true, serialNumber: true },
  });

  let revoked = 0;
  let failed = 0;
  for (const pass of stale) {
    if (await revokePass(pass.serialNumber)) {
      await prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: new Date() } });
      revoked += 1;
    } else {
      failed += 1;
    }
  }

  if (revoked || failed) log.info("[passport] wallet sweep", { revoked, failed });
  return { revoked, failed };
}
