"use client";

/**
 * RequestFilters: client filter bar for the manager master list
 * (/support/all). Status/category/priority selects plus a search box, all
 * driven off the URL query string so the filtered view is shareable and
 * survives a refresh -- same approach as EpicRequestTabs' tab switcher
 * (useRouter + useSearchParams, push a rebuilt URLSearchParams).
 *
 * Reads its current values straight from useSearchParams() rather than via
 * props, so the server page only needs to pass display data (counts, total)
 * and stays the single source of truth for the querystring itself.
 *
 * Any filter change resets `page` back to 1, since the previous page number
 * may no longer exist under the new filter.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { TechRequestStatus } from "@prisma/client";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { STATUS_LABELS } from "./status-badge";
import { CATEGORY_LABELS, PRIORITY_LABELS } from "@/modules/support/labels";
import { ALL_STATUSES, ALL_CATEGORIES, ALL_PRIORITIES } from "@/modules/support/filter-options";

type RequestFiltersProps = {
  counts: Record<TechRequestStatus, number>;
  total: number;
};

export function RequestFilters({ counts, total }: RequestFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = searchParams.get("status") ?? "";
  const category = searchParams.get("category") ?? "";
  const priority = searchParams.get("priority") ?? "";

  const urlQ = searchParams.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const [prevUrlQ, setPrevUrlQ] = useState(urlQ);
  if (urlQ !== prevUrlQ) {
    setPrevUrlQ(urlQ);
    setQ(urlQ);
  }

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    setParam("q", q.trim());
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-44">
        <Field label="Status">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setParam("status", e.target.value)}
          >
            <option value="">All statuses</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]} ({counts[s]})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="w-44">
        <Field label="Category">
          <Select
            aria-label="Filter by category"
            value={category}
            onChange={(e) => setParam("category", e.target.value)}
          >
            <option value="">All categories</option>
            {ALL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="w-40">
        <Field label="Priority">
          <Select
            aria-label="Filter by priority"
            value={priority}
            onChange={(e) => setParam("priority", e.target.value)}
          >
            <option value="">All priorities</option>
            {ALL_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <form onSubmit={submitSearch} className="flex flex-1 min-w-48 items-end gap-2">
        <div className="flex-1">
          <Field label="Search">
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Subject, requester, or ticket #"
              aria-label="Search requests"
            />
          </Field>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
      </form>

      <span className="pb-2 text-sm whitespace-nowrap text-muted-foreground">
        {total.toLocaleString()} {total === 1 ? "request" : "requests"}
      </span>
    </div>
  );
}
