/**
 * Reconciliation for wallet badges.
 *
 * The vendor has no webhooks and no status endpoint, and every revoke path in
 * the app is best-effort, so nothing else guarantees a badge actually dies. This
 * sweep is that guarantee: it re-revokes anything whose term has ended or whose
 * person has been offboarded, and it is safe to run repeatedly because vendor
 * deletes are documented no-ops.
 */

import { prisma } from "@/platform/db";
import { log } from "@/platform/logging";
import { isWalletEnabled, revokePass } from "./wallet-client";

export async function sweepWalletPasses(): Promise<{ revoked: number; failed: number }> {
  if (!isWalletEnabled()) return { revoked: 0, failed: 0 };

  const stale = await prisma.walletPass.findMany({
    where: {
      revokedAt: null,
      OR: [{ term: { endDate: { lt: new Date() } } }, { person: { status: "OFFBOARDED" } }],
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
