import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { fillableForm } from "@/modules/forms/service";
import { FormRenderer } from "@/modules/forms/components/form-renderer";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { DateTime } from "@/platform/dates/display";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";
import { FillForm } from "./fill-form";
import { submitFormAction } from "./actions";

/**
 * Filling out a form. Reached from My info, the dashboard, or a link staff
 * shared; fillableForm decides whether this person may see it at all, and a
 * form they may not see is a 404 rather than a hint that it exists.
 */
export default async function FillFormPage({ params }: { params: Promise<{ id: string }> }) {
  const person = await requireModuleAccess("my-info");
  const { id } = await params;
  const form = await fillableForm(person.personId, id);
  if (!form) notFound();

  const canEdit = form.accepting && (!form.existing || form.allowEdits);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <SetBreadcrumbLeaf label={form.title} />
      <PageHeader title={form.title} />
      {form.description && <p className="whitespace-pre-line text-sm text-foreground-soft">{form.description}</p>}

      {form.existing && (
        <Alert tone="success">
          You responded on <DateTime value={form.existing.submittedAt} />.
          {canEdit ? " You can change your answers below until the form closes." : ""}
        </Alert>
      )}
      {!form.accepting && !form.existing && (
        <Alert tone="info">This form is no longer accepting responses.</Alert>
      )}
      {form.accepting && form.closesAt && (
        <p className="text-sm text-muted-foreground">
          Open until <DateTime value={form.closesAt} />.
        </p>
      )}

      <Card>
        {canEdit ? (
          <FillForm
            layout={form.layout}
            initial={form.existing?.answers ?? {}}
            action={submitFormAction.bind(null, id)}
            submitLabel={form.existing ? "Update my response" : "Submit"}
          />
        ) : (
          <FormRenderer layout={form.layout} initial={form.existing?.answers ?? {}} readOnly />
        )}
      </Card>
    </div>
  );
}
