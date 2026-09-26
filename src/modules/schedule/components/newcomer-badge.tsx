/**
 * The "New" / "Transfer" chip on a builder row: someone new to HAVEN, or a
 * returning member new to THIS department, this term. Directors pair them with
 * experienced people, so every surface that shows a row shows it, and the grid,
 * Day view, and availability view share this one component so the wording
 * cannot drift between them.
 */

import { Badge } from "@/platform/ui/badge";
import type { BuilderMember } from "@/modules/schedule/services/builder";

export function newcomerTitle(newcomer: NonNullable<BuilderMember["newcomer"]>): string {
  if (newcomer.type === "NEW") return "New to HAVEN this term";
  return newcomer.transferFrom.length > 0
    ? `Transferring in from ${newcomer.transferFrom.join(", ")}`
    : "Transferring in from another department";
}

export function NewcomerBadge({ newcomer }: { newcomer: BuilderMember["newcomer"] }) {
  if (!newcomer) return null;
  return (
    <Badge tone="brand" title={newcomerTitle(newcomer)}>
      {newcomer.type === "NEW" ? "New" : "Transfer"}
    </Badge>
  );
}
