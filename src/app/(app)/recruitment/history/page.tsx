import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { NavForm } from "@/platform/ui/nav-form";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

/**
 * Hard cap on how many rows a single search renders. Paired with the total
 * count in the page description and the "showing first N" note below, so a
 * truncated result set is never mistaken for a complete one (this table has no
 * pagination -- narrowing the search term is the intended way to get past 50).
 */
const RESULT_LIMIT = 50;

type PageProps = {
  searchParams: Promise<{ q?: string }>;
};

export default async function RecruitmentHistoryPage({ searchParams }: PageProps) {
  await requirePermission("recruitment.access");
  const { q } = await searchParams;
  const term = q?.trim();

  // Case-insensitive across every identifier a reviewer might type in: first
  // or last name, the display email, any other email on file for this
  // identity, or NetID.
  const where: Prisma.HistoricalApplicantWhereInput = term
    ? {
        OR: [
          { firstName: { contains: term, mode: "insensitive" } },
          { lastName: { contains: term, mode: "insensitive" } },
          { primaryEmail: { contains: term, mode: "insensitive" } },
          { netId: { contains: term, mode: "insensitive" } },
          { emails: { some: { email: { contains: term, mode: "insensitive" } } } },
        ],
      }
    : {};

  const [total, applicants] = await Promise.all([
    prisma.historicalApplicant.count({ where }),
    prisma.historicalApplicant.findMany({
      where,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: RESULT_LIMIT,
    }),
  ]);

  const truncated = total > applicants.length;

  return (
    <div className="space-y-6">
      <SetBreadcrumb trail={recruitmentTrail({ label: "History", href: "/recruitment/history" })} />
      <PageHeader
        title="Recruitment history"
        description={`${total.toLocaleString()} imported ${total === 1 ? "identity" : "identities"}${term ? ` matching "${term}"` : ""}`}
      />

      <NavForm className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-48">
          <Input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search name, NetID, or email..."
            aria-label="Search recruitment history"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
      </NavForm>

      {truncated && (
        <p className="text-sm text-subtle-foreground">
          Showing the first {applicants.length} of {total.toLocaleString()} matches. Narrow your search to see more.
        </p>
      )}

      <Table>
        <THead>
          <tr>
            <TH>Name</TH>
            <TH>NetID</TH>
            <TH>Email</TH>
          </tr>
        </THead>
        <tbody>
          {applicants.map((a) => (
            <TR key={a.id}>
              <TD>
                <Link
                  className="font-medium text-foreground hover:text-brand-fg"
                  href={`/recruitment/history/${a.id}`}
                >
                  {a.firstName} {a.lastName}
                </Link>
              </TD>
              <TD className="text-foreground-soft">{a.netId ?? "-"}</TD>
              <TD className="text-foreground-soft">{a.primaryEmail}</TD>
            </TR>
          ))}
          {applicants.length === 0 && (
            <TR>
              <TD colSpan={3} className="py-10 text-center text-subtle-foreground">
                {term ? "No matches." : "No imported identities."}
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
