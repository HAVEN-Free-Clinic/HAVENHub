import Link from "next/link";
import { ListTruncated } from "@/platform/ui/list-truncated";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import {
  findHistoricalApplicants,
  historicalApplicantLabel,
  historicalApplicantWhere,
  looksLikeEmail,
} from "@/platform/recruitment/historical-applicants";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { FilterBar, FilterField } from "@/platform/ui/filter-bar";
import { Input } from "@/platform/ui/input";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ListEmpty } from "@/platform/ui/list-empty";

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

  // The search and the named-first ordering both live in the shared platform
  // helper, because the command palette runs the identical read and the
  // nameless-identity traps behind this table are only fixed once if there is
  // only one copy of them. See src/platform/recruitment/historical-applicants.ts.
  const where = historicalApplicantWhere(term);
  const [total, ordered] = await Promise.all([
    prisma.historicalApplicant.count({ where }),
    findHistoricalApplicants(where, RESULT_LIMIT),
  ]);

  const truncated = total > ordered.length;

  return (
    <div className="space-y-6">
      <SetBreadcrumb trail={recruitmentTrail({ label: "History", href: "/recruitment/history" })} />
      {/* The count, and the search term it was echoing, both moved onto the
          filter row: the count sits beside the controls that change it, and the
          term is already visible in the search box directly below. */}
      <PageHeader
        title="Recruitment history"
        description="Applicants imported from past cycles, matched into one identity per person."
      />

      <FilterBar
        clearHref={q ? "/recruitment/history" : undefined}
        resultCount={{ total, noun: "identity", pluralNoun: "identities" }}
      >
        <FilterField label="Search" width="grow">
          <Input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Name, NetID, or email..."
          />
        </FilterField>
      </FilterBar>

      {truncated && (
        <ListTruncated
          shown={ordered.length}
          total={total}
          hint="Narrow your search to see more."
        />
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
          {ordered.map((a) => (
            <TR key={a.id}>
              <TD>
                <Link
                  className="font-medium text-foreground hover:text-brand-fg"
                  href={`/recruitment/history/${a.id}`}
                >
                  {historicalApplicantLabel(a)}
                </Link>
              </TD>
              <TD className="text-foreground-soft">{a.netId ?? "-"}</TD>
              {/* A dash rather than the raw value for the ~20 rows whose email
                  column holds something that is not an address: printing those
                  under an Email heading would state something false. The label
                  above still shows the value, where it is honest about being
                  whatever the source recorded. */}
              <TD className="text-foreground-soft">{looksLikeEmail(a.primaryEmail) ? a.primaryEmail : "-"}</TD>
            </TR>
          ))}
          {ordered.length === 0 && (
            <TR>
              <TD colSpan={3} className="py-10 text-center text-subtle-foreground">
                <ListEmpty filtered={Boolean(term)} noun="imported identities" />
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
