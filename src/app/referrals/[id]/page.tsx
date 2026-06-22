import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Phone, MapPin, Languages, Clock, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { getReferralSite, deleteReferralSite } from "@/modules/referrals/services/referrals";
import { ReferralChecklistModal } from "./referral-checklist-modal";
import { DeleteSiteButton } from "./delete-site-button";

const FLAG_STYLES = {
  SUCCESS: { Icon: CheckCircle2, classes: "bg-green-50 text-success" },
  WARN: { Icon: AlertTriangle, classes: "bg-amber-50 text-warning" },
  INFO: { Icon: Info, classes: "bg-blue-50 text-blue-700" },
} as const;

export default async function ReferralSitePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let site;
  try {
    site = await getReferralSite(id);
  } catch {
    notFound();
  }

  async function deleteSiteAction() {
    "use server";
    await deleteReferralSite(id);
    redirect("/referrals");
  }

  const waitDisplay =
    site.waitWeeks === 0
      ? "Available now"
      : site.waitWeeks == null
        ? "Confirm with provider"
        : `~${site.waitWeeks} weeks`;

  const flagStyle = site.flag ? FLAG_STYLES[site.flag] : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title={site.name}
        description={site.specialty}
        action={
          <div className="flex items-center gap-2.5">
            <ReferralChecklistModal
              site={{ name: site.name, specialty: site.specialty, system: site.system, phone: site.phone, address: site.address }}
            />
            <Link
              href={`/referrals/${id}/edit`}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
            >
              Edit
            </Link>
            <DeleteSiteButton action={deleteSiteAction} />
            <Link
              href="/referrals"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to directory
            </Link>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {site.system && <Badge tone="default">{site.system.replace(/_/g, " ")}</Badge>}
        {site.acceptsUninsured && <Badge tone="success">Accepts uninsured</Badge>}
        {site.freeCareEligible && <Badge tone="brand">Free Care</Badge>}
        {site.slidingScale && <Badge tone="warning">Sliding scale</Badge>}
      </div>

      <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
        <div className="p-6 space-y-6">
          {flagStyle && site.flagText && (
            <div className={`flex items-start gap-3 rounded-xl px-4 py-3 ${flagStyle.classes}`}>
              <flagStyle.Icon className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm">{site.flagText}</p>
            </div>
          )}

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Typical wait</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Clock className="h-4 w-4 text-subtle-foreground" aria-hidden />
                {waitDisplay}
              </p>
              {site.waitNote && <p className="mt-1 text-xs text-muted-foreground">{site.waitNote}</p>}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Address</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <MapPin className="h-4 w-4 text-subtle-foreground" aria-hidden />
                {site.address}
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Languages</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Languages className="h-4 w-4 text-subtle-foreground" aria-hidden />
                {site.languages.join(" · ")}
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Scheduling contact</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Phone className="h-4 w-4 text-subtle-foreground" aria-hidden />
                {site.phone ?? "Phone not on file"} · {site.schedulingContact ?? "Scheduling contact not on file"}
            </p>
              {site.fax && <p className="mt-1 text-xs text-muted-foreground">Fax: {site.fax}</p>}
            </div>
          </div>

          {site.providers.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground mb-2">
                Providers at this location
              </p>
              <ul className="space-y-2">
                {site.providers.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 text-sm">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-navy text-white text-xs font-semibold">
                      {p.name.split(" ").filter((w) => w.length > 1).slice(-2).map((w) => w[0]).join("")}
                    </span>
                    <span className="text-foreground font-medium">{p.name}</span>
                    <span className="text-muted-foreground">{p.specialty}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {site.referralSteps.length > 0 && (
            <div className="rounded-xl border border-border bg-muted/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground mb-3">
                Referral process
              </p>
              <ol className="space-y-2">
                {site.referralSteps.map((step, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-foreground">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-faint text-brand-fg text-xs font-semibold mt-0.5">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {site.notes && (
            <div className="border-l-2 border-brand pl-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground mb-1">
                Volunteer note
              </p>
              <p className="text-sm text-foreground">{site.notes}</p>
            </div>
          )}

          {site.lastReviewedAt && (
            <p className="text-xs text-muted-foreground italic pt-2 border-t border-border">
              Last reviewed: {site.lastReviewedAt.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}