import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { auth } from "@/platform/auth/auth";
import { getRenewalContext, resolveRenewalPrefill } from "@/modules/recruitment/services/renewal";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { getDraft } from "@/modules/recruitment/services/drafts";
import { ApplyForm } from "./apply-form";

export default async function ApplyPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ type?: string }> }) {
  const { slug } = await params;
  const { type } = await searchParams;
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: { sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });

  const now = new Date();
  const open = cycle && cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);

  if (!cycle || !open) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-bold">Applications are closed</h1>
        <p className="mt-2 text-muted-foreground">This recruitment form is not currently accepting submissions.</p>
      </main>
    );
  }

  const identity = await getApplicantIdentity();
  if (!identity) redirect(`/apply?next=${encodeURIComponent(`/apply/${slug}`)}`);
  const draft = await getDraft(slug, identity);
  if (draft?.status === "SUBMITTED") {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-bold">Application submitted</h1>
        <p className="mt-2 text-muted-foreground">You have already submitted this application. We will be in touch.</p>
      </main>
    );
  }

  const subcommittees = await prisma.subcommittee.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });

  const def = {
    slug: cycle.publicSlug,
    title: cycle.title,
    track: cycle.track,
    acceptsRenewals: cycle.acceptsRenewals,
    departments: cycle.departments,
    subcommittees,
    sections: cycle.sections.map((s) => ({
      id: s.id, title: s.title, description: s.description, appliesTo: s.appliesTo, departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({ key: f.key, label: f.label, helpText: f.helpText, type: f.type, required: f.required, options: (f.options as { value: string; label: string }[] | null) ?? null, validation: (f.validation as Record<string, unknown> | null) ?? null })),
    })),
  };

  const session = await auth();
  let signedIn = false;
  let signedInName: string | null = null;
  let eligible = false;
  let currentDepartments: string[] = [];
  let prefill: { values: Record<string, string>; lockedKeys: string[] } | undefined;
  if (session?.personId) {
    signedIn = true;
    signedInName = session.user?.name ?? null;
    const ctx = await getRenewalContext(session.personId, session.user?.email ?? null, cycle.track);
    currentDepartments = ctx.currentDepartments.filter((d) => cycle.departments.includes(d));
    // Eligible to renew here only if a current department is offered by this cycle.
    // Otherwise there is nothing to renew into, so route them to the New flow.
    eligible = ctx.eligible && currentDepartments.length > 0;
    const fields = cycle.sections.flatMap((s) => s.fields).map((f) => ({ key: f.key, type: f.type }));
    prefill = resolveRenewalPrefill(fields, ctx);
  }
  const initialApplicantType: "NEW" | "RENEWAL" = type === "renewal" ? "RENEWAL" : "NEW";

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-bold tracking-tight">{def.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Complete the fields below to submit your application. Required fields are marked with{" "}
        <span className="font-medium text-critical">*</span>.
      </p>
      <ApplyForm def={def} signedIn={signedIn} signedInName={signedInName} eligible={eligible} prefill={prefill} currentDepartments={currentDepartments} initialApplicantType={initialApplicantType} initialAnswers={(draft?.answers as Record<string, string>) ?? {}} initialApplicantTypeFromDraft={draft?.applicantType} />
    </main>
  );
}
