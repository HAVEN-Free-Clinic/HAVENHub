import { prisma } from "@/platform/db";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";
import { createCycleAction } from "../../actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function NewCyclePage({ searchParams }: PageProps) {
  const { error } = await searchParams;
  const terms = await prisma.term.findMany({ orderBy: { startDate: "desc" } });
  return (
    <div className="max-w-lg space-y-6">
      <SetBreadcrumb trail={recruitmentTrail({ label: "New cycle" })} />
      <PageHeader title="New recruitment cycle" description="Set up an application cycle, then build its form." />
      <form action={createCycleAction}>
        <Card className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Title">
            <Input name="title" required />
          </Field>
          <Field label="Track">
            <Select name="track">
              <option value="VOLUNTEER">Volunteer</option>
              <option value="DIRECTOR">Director</option>
            </Select>
          </Field>
          <Field label="Term">
            <Select name="termId" required>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Public slug" hint="Optional — auto-generated from the title if left blank.">
            <Input name="publicSlug" placeholder="auto from title" />
          </Field>
          <Field label="Departments" hint="Comma-separated department codes, e.g. SRHD, MDIC.">
            <Input name="departments" placeholder="SRHD, MDIC" />
          </Field>
          <FormActions>
            <SubmitButton pendingLabel="Creating…">Create &amp; build form</SubmitButton>
          </FormActions>
        </Card>
      </form>
    </div>
  );
}
