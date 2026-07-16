import { prisma } from "@/platform/db";
import { requirePermission } from "@/platform/auth/session";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";
import { createCycleAction } from "../../actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { MultiCombobox } from "@/platform/ui/multi-combobox";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { Checkbox } from "@/platform/ui/checkbox";

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function NewCyclePage({ searchParams }: PageProps) {
  // Gate the form on the same permission createCycleAction enforces. Without this
  // a recruitment.access-only user (e.g. an SRR reviewer) could open and fill the
  // form, then get silently bounced to /no-access on submit. Gating here lands
  // them on the friendly /no-access page up front instead.
  await requirePermission("recruitment.manage_cycles");
  const { error } = await searchParams;
  const terms = await prisma.term.findMany({ orderBy: { startDate: "desc" } });
  const activeDepts = await prisma.department.findMany({
    where: { isActive: true },
    select: { code: true, name: true },
    orderBy: { code: "asc" },
  });
  const deptOptions = activeDepts.map((d) => ({ value: d.code, label: `${d.code} - ${d.name}` }));
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
          <Field label="Public slug" hint="Optional, auto-generated from the title if left blank.">
            <Input name="publicSlug" placeholder="auto from title" />
          </Field>
          <Field label="Departments" hint="Search and pick the departments this cycle recruits for.">
            {deptOptions.length === 0 ? (
              <p className="text-sm text-subtle-foreground">
                No active departments to choose from. Add departments in the admin area first.
              </p>
            ) : (
              <MultiCombobox
                name="departments"
                options={deptOptions}
                ariaLabel="Departments"
                placeholder="Search departments…"
              />
            )}
          </Field>
          <label className="flex items-start gap-2.5 py-1 cursor-pointer">
            <Checkbox name="seedDefaultForm" value="on" defaultChecked className="mt-0.5" />
            <span className="text-sm text-foreground">
              Start from the default application form
              <span className="block text-xs text-muted-foreground">
                Uncheck to start with a blank form (name + email only) and build it yourself.
              </span>
            </span>
          </label>
          <FormActions>
            <SubmitButton pendingLabel="Creating…">Create &amp; build form</SubmitButton>
          </FormActions>
        </Card>
      </form>
    </div>
  );
}
