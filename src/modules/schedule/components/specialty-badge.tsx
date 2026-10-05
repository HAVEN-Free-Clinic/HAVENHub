/**
 * The "Specialty" chip on a builder row: the person said on their application
 * that they want to work the rotating specialty clinic (neurology, nephrology,
 * dermatology), or ONLY that. Shared by the grid, Day view, and availability
 * view like NewcomerBadge, so the wording cannot drift between them. A "No"
 * answer shows nothing; the exact answer is in the tooltip.
 */

import { Badge } from "@/platform/ui/badge";
import type { BuilderMember } from "@/modules/schedule/services/builder";

export function SpecialtyBadge({ interest }: { interest: BuilderMember["specialtyInterest"] }) {
  if (!interest?.interested) return null;
  return (
    <Badge tone="brand" title={`Specialty clinic: ${interest.answer}`}>
      {interest.only ? "Specialty only" : "Specialty"}
    </Badge>
  );
}
