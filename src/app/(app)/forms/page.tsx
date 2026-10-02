import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listForms } from "@/modules/forms/service";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { EmptyState } from "@/platform/ui/empty-state";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { TextLink } from "@/platform/ui/text-link";
import { DateOnly } from "@/platform/dates/display";
import { FORM_STATUS_LABELS, FORM_STATUS_TONES } from "./status";

export default async function FormsPage() {
  await requirePermission("forms.manage");
  const forms = await listForms();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forms"
        description="Build forms and surveys, send them to people in the Hub, and read the responses."
        action={
          <Link href="/forms/new" className={buttonClasses("primary", "sm")}>
            New form
          </Link>
        }
      />
      {forms.length === 0 ? (
        <Card>
          <EmptyState inline>
            No forms yet. Start one from a template like volunteer recruitment feedback, or import a
            past survey from Airtable.
          </EmptyState>
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Form</TH>
              <TH>Status</TH>
              <TH>Responses</TH>
              <TH>Last edited</TH>
            </TR>
          </THead>
          <tbody>
            {forms.map((f) => (
              <TR key={f.id}>
                <TD>
                  <TextLink href={`/forms/${f.id}`} className="font-medium">
                    {f.title}
                  </TextLink>
                </TD>
                <TD>
                  <Badge tone={FORM_STATUS_TONES[f.status]}>{FORM_STATUS_LABELS[f.status]}</Badge>
                </TD>
                <TD className="text-muted-foreground">
                  {f._count.responses}
                  {f._count.assignments > 0 && <span className="text-subtle-foreground"> of {f._count.assignments} assigned</span>}
                </TD>
                <TD className="whitespace-nowrap text-muted-foreground">
                  <DateOnly value={f.updatedAt} />
                  {f.updatedBy && <span className="text-subtle-foreground"> by {f.updatedBy.name}</span>}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
