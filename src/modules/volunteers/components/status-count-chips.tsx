import { Badge } from "@/platform/ui/badge";
import {
  ALL_COMPLIANCE_STATUSES,
  complianceStatusLabel,
} from "@/platform/compliance/labels";
import type { ComplianceStatus } from "@/platform/compliance/rules";

/**
 * The per-department compliance summary above a roster: "4 compliant · 2
 * expiring soon".
 *
 * The words are LOWERCASED from the shared staff label rather than re-typed. A
 * chip here is a count phrase ("3 expiring soon"), not a standalone status, so
 * it wants lower case; deriving it is what stops a seventh vocabulary
 * appearing. /volunteers had hand-written all six words beside a table whose
 * badges read complianceStatusLabel(), and the copy had already drifted:
 * EXPIRING_SOON was written "expiring", dropping the one word that separates a
 * certificate expiring soon from one that has already expired. None of the six
 * staff labels contains a proper noun, so toLowerCase is safe on all of them.
 *
 * Zero categories stay hidden ON PURPOSE. This row repeats once per department
 * section, and six always-on chips per section would bury the ones that matter.
 * That is the opposite of /volunteers/master's single clinic-wide tile grid,
 * which shows all six precisely because there is only one of it.
 *
 * No "use client": it renders inside a server page.
 */
export function StatusCountChips({ counts }: { counts: Record<ComplianceStatus, number> }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {ALL_COMPLIANCE_STATUSES.filter((s) => counts[s] > 0).map((s) => {
        const { label, tone } = complianceStatusLabel(s, "staff");
        return (
          <Badge key={s} tone={tone}>{`${counts[s]} ${label.toLowerCase()}`}</Badge>
        );
      })}
    </span>
  );
}
