import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { getContractForReview } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout, type ContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { buildContractReview } from "@/modules/recruitment/contract/review";
import { getObject } from "@/platform/storage";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { DateTime } from "@/platform/dates/display";

function safeLayout(value: unknown): ContractLayout {
  if (value == null) return DEFAULT_CONTRACT_LAYOUT;
  try { return parseContractLayout(value); } catch { return DEFAULT_CONTRACT_LAYOUT; }
}

/** Fetch a signature blob and inline it as a data URI so the private blob is never
 *  exposed via a public URL (the page is already reviewer-gated). */
async function inlineSignature(imageKey: string): Promise<string | null> {
  const bytes = await getObject(imageKey);
  return bytes ? `data:image/png;base64,${bytes.toString("base64")}` : null;
}

export default async function SignedContractPage({ params }: { params: Promise<{ id: string; contractId: string }> }) {
  const { id, contractId } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const found = await getContractForReview(contractId);
  if (!found || found.cycleId !== id) notFound();
  const { contract, ctx } = found;

  const layout = safeLayout(contract.templateSnapshot);
  const review = buildContractReview(contract, layout, ctx);
  const images = await Promise.all(
    review.signatureRows.map((r) => (r.imageKey ? inlineSignature(r.imageKey) : Promise.resolve(null))),
  );

  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Onboarding", slug: "onboarding" },
          leaf: `${contract.firstName} ${contract.lastName}`,
        })}
      />
      <PageHeader
        title={`${contract.firstName} ${contract.lastName}`}
        description={`${contract.email}${contract.submittedAt ? " · signed" : ""}`}
      />

      <Card>
        <SectionHeader>Responses</SectionHeader>
        <dl className="mt-3 divide-y divide-border-subtle">
          {review.responses.map((f, i) => (
            <div key={`${f.label}-${i}`} className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr]">
              <dt className="text-xs text-subtle-foreground">{f.label}</dt>
              <dd className="text-sm text-foreground">
                {f.cert ? (
                  <a
                    href={`/api/recruitment/onboarding/${contract.id}/hipaa?inline=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-fg underline hover:text-brand-hover"
                  >
                    {f.value}
                  </a>
                ) : f.value != null ? (
                  f.value
                ) : (
                  <span className="italic text-subtle-foreground">Not provided</span>
                )}
              </dd>
            </div>
          ))}
          {review.responses.length === 0 && (
            <p className="text-sm text-muted-foreground">No responses recorded.</p>
          )}
        </dl>
      </Card>

      {review.agreements.length > 0 && (
        <Card>
          <SectionHeader>Agreements</SectionHeader>
          <ul className="mt-3 space-y-2">
            {review.agreements.map((a) => (
              <li key={a.blockId} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground">{a.title}</span>
                <Badge tone={a.confirmed ? "success" : "warning"}>
                  {a.confirmed ? (a.confirmKind === "checkbox" ? "Confirmed" : "Signed") : "Not completed"}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <SectionHeader>Signatures</SectionHeader>
        <dl className="mt-3 space-y-4">
          {review.signatureRows.map((r, i) => {
            // A legacy (pre-feature) typed-name row sets both `legacyText` and `name`
            // to the same raw string, and the main text above already renders
            // `legacyText`. Suppress the byline name when it would just repeat it, so
            // a legacy signature shows once (drawn signatures keep name + signedAt +
            // method, since their `legacyText` is null).
            const bylineName = r.name && r.name !== r.legacyText ? r.name : "";
            return (
              <div key={r.blockId} className="border-b border-border-subtle pb-4 last:border-0 last:pb-0">
                <dt className="text-xs text-subtle-foreground">{r.title}</dt>
                <dd className="mt-1 text-sm text-foreground">
                  {images[i] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- inline signature data URI, not a remote asset
                    <img src={images[i]!} alt={`${r.title} signature`} className="h-20 rounded border border-border-subtle bg-white" />
                  ) : r.legacyText ? (
                    <span className="font-medium">{r.legacyText}</span>
                  ) : (
                    <span className="italic text-subtle-foreground">Not signed</span>
                  )}
                  {(bylineName || r.signedAt) && (
                    <p className="mt-1 text-xs text-subtle-foreground">
                      {bylineName}
                      {bylineName && r.signedAt ? " · " : ""}
                      {r.signedAt ? <>signed <DateTime value={new Date(r.signedAt)} /></> : null}
                      {r.method ? ` · ${r.method === "type" ? "typed" : "drawn"}` : ""}
                    </p>
                  )}
                </dd>
              </div>
            );
          })}
          {review.signatureRows.length === 0 && <p className="text-sm text-muted-foreground">This contract has no signature blocks.</p>}
        </dl>
      </Card>
    </div>
  );
}
