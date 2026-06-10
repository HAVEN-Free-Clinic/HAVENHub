/**
 * ITCM Epic Requests page.
 *
 * Provides a form-driven workflow for generating YNHH Electronic Service
 * Request PDFs, companion Excel spreadsheets (bulk only), and email drafts
 * for all five request scenarios:
 *
 *   1. New individual   — new Epic account for one person
 *   2. Modify individual — extend access for one person (already has Epic ID)
 *   3. Renew individual  — same PDF as modify, different email subject/body
 *   4. Bulk new          — new accounts for many people; generates spreadsheet
 *   5. Bulk mod/renew    — extend access for many people; generates spreadsheet
 *
 * The page is a server component that loads department/member data. The
 * generate button posts to a server action which fills the PDF template,
 * builds the spreadsheet if needed, and returns a JSON payload the client
 * uses to trigger downloads and show the email draft.
 *
 * Mirror person logic: for individual requests, the server action finds
 * another active member in the same department with the same role (director
 * mirrors director, volunteer mirrors volunteer) who already has an Epic ID.
 * For bulk requests the same logic applies using the first selected person's
 * department and role.
 */

import { requirePermission } from "@/platform/auth/session";
import { listDepartmentsWithMembers } from "@/modules/admin/services/itcm";
import { PageHeader } from "@/platform/ui/page-header";
import { EpicRequestForm } from "@/modules/admin/components/epic-request-form";

export default async function EpicRequestsPage() {
  await requirePermission("admin.access");

  // Load all departments with their active-term members for the person selector.
  const departments = await listDepartmentsWithMembers();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Epic Requests"
        description="Generate YNHH service request PDFs, spreadsheets, and email drafts for new, modify, and renew Epic access requests."
      />
      <EpicRequestForm departments={departments} />
    </div>
  );
}