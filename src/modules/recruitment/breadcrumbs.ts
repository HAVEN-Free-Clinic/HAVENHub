import type { Crumb } from "@/platform/ui/breadcrumb-trail";

/**
 * Recruitment breadcrumb trails (rich, per-page "option B").
 *
 * The static-nav breadcrumb builder can't describe recruitment's hierarchy:
 * every real page lives under the dynamic `/recruitment/cycles/[id]/…` routes,
 * and the registry only knows the module root. So recruitment pages supply
 * their own trail (cycle title + section + leaf) via `SetBreadcrumb`.
 *
 * The renderer drops the link on whichever crumb is last (the current page),
 * so it is fine for every crumb here to carry an `href`.
 */

const HUB: Crumb = { label: "Hub", href: "/" };
const RECRUITMENT: Crumb = { label: "Recruitment", href: "/recruitment" };

/** Prepend the shared `Hub > Recruitment` prefix to a recruitment trail. */
export function recruitmentTrail(...tail: Crumb[]): Crumb[] {
  return [HUB, RECRUITMENT, ...tail];
}

/** A section within a cycle, e.g. `{ label: "Applicants", slug: "applicants" }`. */
export type CycleSection = { label: string; slug: string };

/**
 * Trail for a page inside a specific recruitment cycle:
 *
 *   Hub > Recruitment > {cycle title} [> {section}] [> {leaf}]
 *
 * The cycle crumb links to the cycle overview and the section crumb links to
 * the section index, so any crumb above the current page is navigable.
 */
export function cycleTrail(opts: {
  cycleId: string;
  cycleTitle: string;
  section?: CycleSection;
  leaf?: string;
}): Crumb[] {
  const { cycleId, cycleTitle, section, leaf } = opts;
  const base = `/recruitment/cycles/${cycleId}`;
  const crumbs = recruitmentTrail({ label: cycleTitle, href: base });
  if (section) crumbs.push({ label: section.label, href: `${base}/${section.slug}` });
  if (leaf) crumbs.push({ label: leaf });
  return crumbs;
}
