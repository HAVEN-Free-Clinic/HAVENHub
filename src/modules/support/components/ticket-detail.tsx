/**
 * TicketDetail: full-page view of a single TechRequest, shared by the
 * requester and (once `canManage` is true) support managers. The [id] page
 * loads `detail` via getTechRequest - which already enforces that only the
 * requester or a support.manage_requests holder can reach this component -
 * and passes it straight through.
 *
 * This task (5) only builds the owner-visible parts: header, description,
 * and the resolution once one exists. It is deliberately structured with
 * three extension seams for later tasks, so they can add content without
 * restructuring this component:
 *   - a `canManage` gated block for manager controls (assignment,
 *     status/priority changes, the Epic promotion pipeline)
 *   - a comment thread seam (Task 6: TechRequestComment history + reply form)
 *   - an attachments seam (Task 7: TechRequestAttachment list + upload)
 * Each seam below is a no-op today (renders nothing) - a later task fills it
 * in without touching the header/description/resolution above it.
 */

import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { fmtDate } from "@/platform/dates";
import { SupportStatusBadge } from "./status-badge";
import { CATEGORY_LABELS } from "@/modules/support/labels";
import type { TechRequestDetail } from "../services/tech-request";

type TicketDetailProps = {
  detail: TechRequestDetail;
  /** True when the caller holds support.manage_requests. Gates manager-only sections. */
  canManage?: boolean;
};

export function TicketDetail({ detail, canManage = false }: TicketDetailProps) {
  return (
    <div className="space-y-8">
      <PageHeader
        title={detail.subject}
        description={`#${detail.number} · ${CATEGORY_LABELS[detail.category]} · Submitted ${fmtDate(
          detail.createdAt
        )}`}
        action={<SupportStatusBadge status={detail.status} />}
      />

      <section>
        <SectionHeader className="mb-2">Description</SectionHeader>
        <Card>
          <p className="whitespace-pre-wrap text-sm text-foreground">{detail.description}</p>
        </Card>
      </section>

      {detail.resolution && (
        <section>
          <SectionHeader className="mb-2">Resolution</SectionHeader>
          <Card>
            <p className="whitespace-pre-wrap text-sm text-foreground">{detail.resolution}</p>
          </Card>
        </section>
      )}

      {/* Manager controls seam: added in a later task */}

      {/* Comment thread seam: Task 6 adds TechRequestComment history + a reply form here. */}

      {/* Attachments seam: Task 7 adds the TechRequestAttachment list + upload here. */}
    </div>
  );
}
