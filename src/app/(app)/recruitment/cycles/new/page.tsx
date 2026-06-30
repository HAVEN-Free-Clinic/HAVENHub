import { prisma } from "@/platform/db";
import { requirePermission } from "@/platform/auth/session";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";
import { createCycleAction } from "../../actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";

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
  return (
    <div className="max-w-lg space-y-6">
      <SetBreadcrumb trail={recruitmentTrail({ label: "New cycle" })} />
      <PageHeader title="New recruitment cycle" description="Set up an application cycle, then build its form." />
      {error && <Alert tone="error">{error}</Alert>}
      <form action={createCycleAction} className="space-y-4">
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
        <SubmitButton pendingLabel="Creating…">Create &amp; build form</SubmitButton>
      </form>
    </div>
  );
}
