"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Search } from "lucide-react";
import { Badge } from "@/platform/ui/badge";

type Site = {
  id: string;
  name: string;
  specialty: string;
  category: string;
  system: string | null;
  acceptsUninsured: boolean;
  freeCareEligible: boolean;
  waitWeeks: number | null;
  languages: string[];
  notes: string | null;
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
};

type SortKey = "name" | "wait" | "category";

export function ReferralDirectoryBrowser({ sites }: { sites: Site[] }) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [onlyUninsured, setOnlyUninsured] = useState(false);
  const [onlyFreeCare, setOnlyFreeCare] = useState(false);
  const [onlyFast, setOnlyFast] = useState(false);
  const [onlySpanish, setOnlySpanish] = useState(false);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: sites.length };
    for (const s of sites) counts[s.category] = (counts[s.category] ?? 0) + 1;
    return counts;
  }, [sites]);

  const filtered = useMemo(() => {
    let list = sites.filter((s) => {
      if (activeCategory !== "all" && s.category !== activeCategory) return false;
      if (onlyUninsured && !s.acceptsUninsured) return false;
      if (onlyFreeCare && !s.freeCareEligible) return false;
      if (onlyFast && (s.waitWeeks == null || s.waitWeeks >= 4)) return false;
      if (onlySpanish && !s.languages.some((l) => l.toLowerCase().includes("spanish"))) return false;
      if (query) {
        const haystack = `${s.name} ${s.specialty} ${s.system} ${s.languages.join(" ")} ${s.notes ?? ""}`.toLowerCase();
        if (!haystack.includes(query.toLowerCase())) return false;
      }
      return true;
    });

    if (sort === "wait") {
      list = [...list].sort((a, b) => (a.waitWeeks ?? 999) - (b.waitWeeks ?? 999));
    } else if (sort === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === "category") {
      list = [...list].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    }

    return list;
  }, [sites, activeCategory, sort, onlyUninsured, onlyFreeCare, onlyFast, onlySpanish, query]);

  const categories = ["all", ...Object.keys(CATEGORY_LABELS)];

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
          <div className="flex flex-col gap-1 mb-4">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm text-left transition ${
                  activeCategory === cat
                    ? "bg-navy text-white font-medium"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <span>{cat === "all" ? "All providers" : CATEGORY_LABELS[cat]}</span>
                <span
                  className={`text-xs rounded-full px-1.5 ${
                    activeCategory === cat ? "bg-white/20" : "bg-muted-strong text-muted-foreground"
                  }`}
                >
                  {categoryCounts[cat] ?? 0}
                </span>
              </button>
            ))}
          </div>

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
          <div className="rounded-2xl border border-border bg-surface p-12 text-center">
            <Search className="mx-auto h-8 w-8 text-subtle-foreground mb-3" aria-hidden />
            <p className="text-sm text-muted-foreground">No providers match — try clearing filters or adjusting your search.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
            <ul className="divide-y divide-border-subtle">
              {filtered.map((site) => (
                <li key={site.id}>
                  <Link
                    href={`/referrals/${site.id}`}
                    className="flex items-start justify-between gap-4 px-6 py-4 transition hover:bg-muted"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-faint text-brand-fg">
                        <Building2 className="h-[18px] w-[18px]" aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{site.name}</p>
                        <p className="text-xs text-muted-foreground">{site.specialty}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {site.acceptsUninsured && <Badge tone="success">Uninsured OK</Badge>}
                      {site.freeCareEligible && <Badge tone="brand">Free Care</Badge>}
                      {site.waitWeeks != null && (
                        <Badge tone={site.waitWeeks <= 2 ? "success" : site.waitWeeks <= 6 ? "warning" : "critical"}>
                          ~{site.waitWeeks} wk wait
                        </Badge>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}