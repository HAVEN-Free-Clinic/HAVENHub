import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { getContractForReview } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout, type ContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { buildContractSignatureView } from "@/modules/recruitment/contract/signatures";
import { getObject } from "@/platform/storage";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
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
  const { contract } = found;

  const layout = safeLayout(contract.templateSnapshot);
  const rows = buildContractSignatureView(layout, contract.signatures);
  const images = await Promise.all(
    rows.map((r) => (r.imageKey ? inlineSignature(r.imageKey) : Promise.resolve(null))),
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
        <SectionHeader>Signatures</SectionHeader>
        <dl className="mt-3 space-y-4">
          {rows.map((r, i) => (
            <div key={r.blockId} className="border-b border-border-subtle pb-4 last:border-0 last:pb-0">
              <dt className="text-xs text-subtle-foreground">{r.title}</dt>
              <dd className="mt-1 text-sm text-foreground">
                {images[i] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- inline signature data URI, not a remote asset
                  <img src={images[i]!} alt={`${r.title} signature`} className="h-20 rounded border border-border-subtle bg-surface" />
                ) : r.legacyText ? (
                  <span className="font-medium">{r.legacyText}</span>
                ) : (
                  <span className="italic text-subtle-foreground">Not signed</span>
                )}
                {(r.name || r.signedAt) && (
                  <p className="mt-1 text-xs text-subtle-foreground">
                    {r.name}
                    {r.name && r.signedAt ? " · " : ""}
                    {r.signedAt ? <>signed <DateTime value={new Date(r.signedAt)} /></> : null}
                    {r.method ? ` · ${r.method === "type" ? "typed" : "drawn"}` : ""}
                  </p>
                )}
              </dd>
            </div>
          ))}
          {rows.length === 0 && <p className="text-sm text-muted-foreground">This contract has no signature blocks.</p>}
        </dl>
      </Card>
    </div>
  );
}
