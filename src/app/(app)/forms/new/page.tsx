import { requirePermission } from "@/platform/auth/session";
import { config } from "@/platform/config";
import { FORM_TEMPLATES } from "@/modules/forms/templates";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Input, Field } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { SectionHeader } from "@/platform/ui/section-header";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";
import { createFormAction, importAirtableAction } from "../actions";

export default async function NewFormPage() {
  await requirePermission("forms.manage");
  const options = [
    { id: "", title: "Blank form", summary: "Start from nothing and add your own questions." },
    ...FORM_TEMPLATES.map((t) => ({ id: t.id, title: t.title, summary: t.summary })),
  ];

  return (
    <div className="space-y-8">
      <SetBreadcrumbLeaf label="New form" />
      <PageHeader title="New form" description="Start blank, from a template, or from a past Airtable survey." />

      <form action={createFormAction} className="space-y-6">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground-soft">Start from</legend>
          <div className="grid gap-3 md:grid-cols-3">
            {options.map((o, i) => (
              <label
                key={o.id || "blank"}
                className="flex cursor-pointer gap-3 rounded-xl border border-border bg-surface p-4 has-[:checked]:border-brand has-[:checked]:ring-2 has-[:checked]:ring-brand/15"
              >
                {/* eslint-disable-next-line no-restricted-syntax -- radio card: the whole card is the control's label */}
                <input type="radio" name="templateId" value={o.id} defaultChecked={i === 1} className="mt-1 accent-brand" />
                <span>
                  <span className="block text-sm font-semibold text-foreground">{o.title}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{o.summary}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Title" hint="Optional. Defaults to the template's title.">
            <Input name="title" className="w-80" />
          </Field>
          <SubmitButton pendingLabel="Creating…">Create form</SubmitButton>
        </div>
      </form>

      <section className="space-y-3 border-t border-border pt-6">
        <SectionHeader level="title">Import from Airtable</SectionHeader>
        <Card className="space-y-4">
          <p className="text-sm text-foreground-soft">
            Turns an Airtable table into a closed Hub form with its past responses, matched to people
            in the Hub. Questions come from the table&apos;s fields; lookups and formulas are left
            out. Importing the same table again adds new rows instead of duplicating.
          </p>
          {config.AIRTABLE_PAT ? (
            <form action={importAirtableAction} className="flex flex-wrap items-end gap-3">
              <Field label="Airtable table link">
                <Input name="airtable" required placeholder="https://airtable.com/app…/tbl…" className="w-[28rem] max-w-full" />
              </Field>
              <Field label="Title (optional)">
                <Input name="title" className="w-64" />
              </Field>
              <SubmitButton pendingLabel="Importing…">Import</SubmitButton>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not available: the Hub has no Airtable token configured.
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
