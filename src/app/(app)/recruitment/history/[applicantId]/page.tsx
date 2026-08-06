import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getApplicantHistory } from "@/modules/recruitment/services/history";
import { ApplicantHistory } from "@/modules/recruitment/components/applicant-history";
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { canAccessModule } from "@/platform/modules/access";
import { getModule } from "@/platform/modules/registry";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";

type PageProps = {
  params: Promise<{ applicantId: string }>;
};

export default async function HistoricalApplicantDetailPage({ params }: PageProps) {
  const session = await requirePermission("recruitment.access");
  const { applicantId } = await params;

  const applicant = await prisma.historicalApplicant.findUnique({
    where: { id: applicantId },
    include: { emails: true, person: true },
  });
  if (!applicant) notFound();

  // Same gate the command-palette's People search uses (see adminPeople in
  // src/modules/search/entities.ts): admin.manage_people alone does not imply
  // admin module access (a role can be composed with the fine-grained
  // permission but not admin.access), and /admin/people/[id] sits behind the
  // module layout's admin.access gate. Checking both here is what keeps this
  // link from ever bouncing a viewer to /no-access.
  const perms = await getEffectivePermissions(session.personId);
  const canViewPerson =
    hasPermission(perms, "admin.manage_people") && canAccessModule(getModule("admin")!, perms);

  const name = `${applicant.firstName} ${applicant.lastName}`;

  const history = await getApplicantHistory({
    netId: applicant.netId,
    emails: applicant.emails.map((e) => e.email),
    personId: applicant.personId,
  });

  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={recruitmentTrail({ label: "History", href: "/recruitment/history" }, { label: name })}
      />
      <PageHeader title={name} description={applicant.netId ? `NetID ${applicant.netId}` : undefined} />

      <Card className="space-y-3">
        <SectionHeader>Known emails</SectionHeader>
        {/* Every email on file for this identity, not just the primary one:
            this is the diagnostic surface for a wrong identity merge -- seeing
            two unrelated addresses side by side is how a human notices. */}
        {applicant.emails.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No emails on file.</p>
        ) : (
          <ul className="space-y-1.5">
            {applicant.emails.map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-sm text-foreground">
                {e.email}
                {e.email === applicant.primaryEmail && <Badge>Primary</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {applicant.person && (
        <Card className="space-y-2">
          <SectionHeader>Linked person</SectionHeader>
          {canViewPerson ? (
            <Link
              href={`/admin/people/${applicant.person.id}`}
              className="text-sm font-medium text-brand-fg hover:text-brand-hover"
            >
              {applicant.person.name}
            </Link>
          ) : (
            <p className="text-sm text-foreground">{applicant.person.name}</p>
          )}
        </Card>
      )}

      <ApplicantHistory history={history} title="Timeline" />
    </div>
  );
}
