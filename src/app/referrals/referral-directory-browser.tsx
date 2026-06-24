"use client";

import { useState } from "react";
import Link from "next/link";
import { Building2, Search, ChevronDown, MapPin, Languages, Phone, Clock, ClipboardCheck } from "lucide-react";
import { ReferralChecklistModal } from "@/app/referrals/components/referral-checklist-modal";
import { DeleteSiteButton } from "@/app/referrals/components/delete-site-button";
import { PhoneCopyButton } from "@/app/referrals/components/phone-copy-button";

type Site = {
  id: string;
  name: string;
  specialty: string;
  category: string;
  system: string | null;
  acceptsUninsured: boolean;
  freeCareEligible: boolean;
  slidingScale: boolean;
  waitWeeks: number | null;
  waitNote: string | null;
  phone: string | null;
  address: string;
  languages: string[];
  schedulingContact: string | null;
  referralSteps: string[];
  notes: string | null;
  providers: { id: string; name: string; specialty: string }[];
};

const CATEGORY_LABELS: Record<string, string> = {
  COMMUNITY_HEALTH: "Community health",
  CARDIOLOGY: "Cardiology",
  ENDOCRINOLOGY: "Endocrinology",
  GASTROENTEROLOGY: "Gastroenterology",
  BEHAVIORAL_HEALTH: "Behavioral health",
  OBGYN: "OB-GYN",
  ORTHOPEDICS: "Orthopedics",
  DERMATOLOGY: "Dermatology",
  PULMONOLOGY: "Pulmonology",
  NEUROLOGY: "Neurology",
  OPHTHALMOLOGY: "Ophthalmology",
  ENT: "ENT",
  DENTAL: "Dental",
  SOCIAL_SERVICES: "Social services",
  INTERNAL_MEDICINE: "Internal medicine",
  SURGERY: "Surgery",
  PEDIATRICS: "Pediatrics",
  ANESTHESIOLOGY: "Anesthesiology",
  EMERGENCY_MEDICINE: "Emergency medicine",
  PSYCHIATRY: "Psychiatry",
  MEDICINE: "Medicine",
  UROLOGY: "Urology",
  NEUROSURGERY: "Neurosurgery",
  PODIATRY: "Podiatry",
  THERAPEUTIC_RADIOLOGY: "Therapeutic radiology",
  RADIOLOGY: "Radiology",
  RADIATION_ONCOLOGY: "Radiation oncology",
  CHILD_PSYCHIATRY: "Child psychiatry",
  REHAB_MEDICINE: "Rehab medicine",
  PATHOLOGY: "Pathology",
  ORAL_MAXILLOFACIAL_SURGERY: "Oral & maxillofacial surgery",
};

const CATEGORY_CLUSTERS: { label: string; color: string; bg: string; categories: string[] }[] = [
  {
    label: "Primary & community",
    color: "#04342C",
    bg: "#E1F5EE",
    categories: ["COMMUNITY_HEALTH", "INTERNAL_MEDICINE", "MEDICINE", "PEDIATRICS"],
  },
  {
    label: "Specialty medical",
    color: "#042C53",
    bg: "#E6F1FB",
    categories: [
      "CARDIOLOGY", "ENDOCRINOLOGY", "GASTROENTEROLOGY", "OBGYN", "ORTHOPEDICS",
      "DERMATOLOGY", "PULMONOLOGY", "NEUROLOGY", "OPHTHALMOLOGY", "ENT",
      "UROLOGY", "NEUROSURGERY", "PODIATRY", "RADIOLOGY", "RADIATION_ONCOLOGY",
      "THERAPEUTIC_RADIOLOGY", "PATHOLOGY", "REHAB_MEDICINE", "SURGERY",
      "ANESTHESIOLOGY", "EMERGENCY_MEDICINE",
    ],
  },
  {
    label: "Behavioral & social",
    color: "#4B1528",
    bg: "#FBEAF0",
    categories: ["BEHAVIORAL_HEALTH", "PSYCHIATRY", "CHILD_PSYCHIATRY", "SOCIAL_SERVICES"],
  },
  {
    label: "Dental",
    color: "#4A1B0C",
    bg: "#FAECE7",
    categories: ["DENTAL", "ORAL_MAXILLOFACIAL_SURGERY"],
  },
];

function clusterFor(category: string) {
  return CATEGORY_CLUSTERS.find((c) => c.categories.includes(category)) ?? CATEGORY_CLUSTERS[1];
}

function statusPills(site: Site): { short: string; full: string; confirmed: boolean }[] {
  const pills: { short: string; full: string; confirmed: boolean }[] = [];

  if (site.waitWeeks == null) {
    pills.push({ short: "Wait time", full: "Wait time for appointment unconfirmed", confirmed: false });
  } else {
    pills.push({ short: `~${site.waitWeeks} wk wait`, full: `Confirmed wait time: about ${site.waitWeeks} weeks`, confirmed: true });
  }

  if (!site.freeCareEligible) {
    pills.push({ short: "Free Care", full: "Free Care coverage unconfirmed", confirmed: false });
  } else {
    pills.push({ short: "Free Care", full: "Confirmed: Free Care covers visits here", confirmed: true });
  }

  if (!site.acceptsUninsured) {
    pills.push({ short: "Uninsured", full: "Uninsured coverage unconfirmed", confirmed: false });
  } else {
    pills.push({ short: "Uninsured", full: "Confirmed: this provider accepts uninsured patients", confirmed: true });
  }

  return pills;
}

function SiteRow({ site, deleteSiteAction }: { site: Site; deleteSiteAction: (id: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const cluster = clusterFor(site.category);

  async function boundDelete() {
    await deleteSiteAction(site.id);
  }

  return (
    <li>
      <div
        onClick={() => setExpanded((e) => !e)}
        className="flex items-start justify-between gap-4 px-6 py-4 cursor-pointer transition hover:bg-muted"
      >
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-faint text-brand-fg">
            <Building2 className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{site.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span
                className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                style={{ background: cluster.bg, color: cluster.color }}
              >
                {CATEGORY_LABELS[site.category] ?? site.category}
              </span>
              {statusPills(site).map((p) => (
                <span
                  key={p.short}
                  title={p.full}
                  className={`text-[11px] px-2 py-0.5 rounded-full cursor-help ${
                    p.confirmed ? "bg-green-50 text-success" : "bg-muted-strong text-muted-foreground"
                  }`}
                >
                  {p.short}
                </span>
              ))}
            </div>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-subtle-foreground mt-1 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        />
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted/30 px-6 py-5 space-y-4" onClick={(e) => e.stopPropagation()}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Address</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <MapPin className="h-3.5 w-3.5 text-subtle-foreground" aria-hidden />
                {site.address}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Languages</p>
              <p className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Languages className="h-3.5 w-3.5 text-subtle-foreground" aria-hidden />
                {site.languages.length > 0 ? site.languages.join(" · ") : "Not on file"}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground mb-1">Scheduling contact</p>
              <div className="flex flex-wrap items-center gap-2">
                <PhoneCopyButton phone={site.phone} />
                <span className="text-sm text-muted-foreground">{site.schedulingContact ?? "Contact not on file"}</span>
              </div>
            </div>
            {site.waitNote && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Wait note</p>
                <p className="mt-1 flex items-center gap-2 text-sm text-foreground">
                  <Clock className="h-3.5 w-3.5 text-subtle-foreground" aria-hidden />
                  {site.waitNote}
                </p>
              </div>
            )}
          </div>

          {site.providers.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground mb-2">
                Providers at this location
              </p>
              <ul className="space-y-1.5">
                {site.providers.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 text-sm">
                    <span className="text-foreground font-medium">{p.name}</span>
                    <span className="text-muted-foreground">{p.specialty}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {site.referralSteps.length > 0 && (
            <div className="rounded-xl border border-border bg-surface p-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground mb-2">
                Referral process
              </p>
              <ol className="space-y-1.5">
                {site.referralSteps.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                    <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-brand-faint text-brand-fg text-[10px] font-semibold mt-0.5">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {site.notes && (
            <div className="border-l-2 border-brand pl-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground mb-1">Volunteer note</p>
              <p className="text-sm text-foreground">{site.notes}</p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <ReferralChecklistModal
              site={{ name: site.name, specialty: site.specialty, system: site.system, phone: site.phone, address: site.address }}
            />
            <Link
              href={`/referrals/${site.id}/edit`}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              Edit
            </Link>
            <DeleteSiteButton action={boundDelete} />
          </div>
        </div>
      )}
    </li>
  );
}

type SortKey = "name" | "wait" | "category";

export function ReferralDirectoryBrowser({
  sites,
  deleteSiteAction,
}: {
  sites: Site[];
  deleteSiteAction: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [onlyUninsured, setOnlyUninsured] = useState(false);
  const [onlyFreeCare, setOnlyFreeCare] = useState(false);
  const [onlyFast, setOnlyFast] = useState(false);
  const [onlySpanish, setOnlySpanish] = useState(false);

  const [openClusters, setOpenClusters] = useState<Set<string>>(new Set());

  function toggleCluster(label: string) {
    setOpenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  const categoryCounts: Record<string, number> = { all: sites.length };
  for (const s of sites) categoryCounts[s.category] = (categoryCounts[s.category] ?? 0) + 1;

  let filtered = sites.filter((s) => {
    if (activeCategory !== "all" && s.category !== activeCategory) return false;
    if (onlyUninsured && !s.acceptsUninsured) return false;
    if (onlyFreeCare && !s.freeCareEligible) return false;
    if (onlyFast && (s.waitWeeks == null || s.waitWeeks >= 4)) return false;
    if (onlySpanish && !s.languages.some((l) => l.toLowerCase().includes("spanish"))) return false;
    if (query) {
      const haystack = `${s.name} ${s.specialty} ${s.system ?? ""} ${s.languages.join(" ")} ${s.notes ?? ""}`.toLowerCase();
      if (!haystack.includes(query.toLowerCase())) return false;
    }
    return true;
  });

  if (sort === "wait") {
    filtered = [...filtered].sort((a, b) => (a.waitWeeks ?? 999) - (b.waitWeeks ?? 999));
  } else if (sort === "name") {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === "category") {
    filtered = [...filtered].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr] items-start">
      <aside className="space-y-4 lg:sticky lg:top-20">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-subtle-foreground" aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search provider, specialty, language…"
              className="w-full rounded-lg border border-border-strong bg-surface pl-9 pr-3 py-2 text-sm outline-none focus-visible:border-brand"
            />
          </div>

          <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground mb-2">Category</p>
          <select
            value={activeCategory}
            onChange={(e) => setActiveCategory(e.target.value)}
            className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm mb-4"
          >
            <option value="all">All providers ({categoryCounts.all})</option>
            {CATEGORY_CLUSTERS.map((cluster) => (
              <optgroup key={cluster.label} label={cluster.label}>
                {cluster.categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_LABELS[cat]} ({categoryCounts[cat] ?? 0})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground mb-2">Sort by</p>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm mb-4"
          >
            <option value="name">Provider name (A–Z)</option>
            <option value="wait">Wait time (shortest first)</option>
            <option value="category">Category</option>
          </select>

          <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground mb-2">Filter</p>
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between text-sm text-foreground-soft">
              Accepts uninsured
              <input type="checkbox" checked={onlyUninsured} onChange={(e) => setOnlyUninsured(e.target.checked)} className="h-4 w-4 accent-brand" />
            </label>
            <label className="flex items-center justify-between text-sm text-foreground-soft">
              Free Care covered
              <input type="checkbox" checked={onlyFreeCare} onChange={(e) => setOnlyFreeCare(e.target.checked)} className="h-4 w-4 accent-brand" />
            </label>
            <label className="flex items-center justify-between text-sm text-foreground-soft">
              Wait &lt; 4 weeks
              <input type="checkbox" checked={onlyFast} onChange={(e) => setOnlyFast(e.target.checked)} className="h-4 w-4 accent-brand" />
            </label>
            <label className="flex items-center justify-between text-sm text-foreground-soft">
              Spanish available
              <input type="checkbox" checked={onlySpanish} onChange={(e) => setOnlySpanish(e.target.checked)} className="h-4 w-4 accent-brand" />
            </label>
          </div>
        </div>
      </aside>

      <div>
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface p-14 text-center">
            <Search className="mx-auto h-10 w-10 text-subtle-foreground/40 mb-4" aria-hidden />
            <p className="text-sm font-medium text-foreground">No providers match</p>
            <p className="mt-1 text-sm text-muted-foreground">Try clearing filters or adjusting your search.</p>
          </div>
        ) : activeCategory !== "all" ? (
          <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
            <ul className="divide-y divide-border-subtle">
              {filtered.map((site) => (
                <SiteRow key={site.id} site={site} deleteSiteAction={deleteSiteAction} />
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-3">
            {CATEGORY_CLUSTERS.map((cluster) => {
              const clusterSites = filtered.filter((s) => cluster.categories.includes(s.category));
              if (clusterSites.length === 0) return null;
              const isOpen = openClusters.has(cluster.label);
              return (
                <div
                  key={cluster.label}
                  className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden"
                >
                  <button
                    onClick={() => toggleCluster(cluster.label)}
                    className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-muted"
                  >
                    <div className="flex items-center gap-3">
                      <span className="h-3 w-3 rounded-full shrink-0" style={{ background: cluster.color }} />
                      <h3 className="text-sm font-semibold text-foreground">{cluster.label}</h3>
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{ background: cluster.bg, color: cluster.color }}
                      >
                        {clusterSites.length}
                      </span>
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-subtle-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                      aria-hidden
                    />
                  </button>

                  {isOpen && (
                    <ul className="divide-y divide-border-subtle border-t border-border">
                      {clusterSites.map((site) => (
                        <SiteRow key={site.id} site={site} deleteSiteAction={deleteSiteAction} />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}