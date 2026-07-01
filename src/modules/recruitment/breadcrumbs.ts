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

/**
 * Trail for the interview detail page, which lives at `/recruitment/interviews/[id]`
 * (outside the recruitment-staff `recruitment.access` gate), so interview
 * panelists, who are not recruitment staff, can reach it. The page is shared with
 * cycle staff, so the trail is role-aware: every crumb links somewhere the viewer
 * can actually go.
 *
 * - `staff` viewers (cycle managers / department reviewers) get the cycle path,
 *   landing back on the cycle's interview list.
 * - panelists get `Hub > My interviews > {candidate}`; the cycle crumbs would only
 *   point at pages the recruitment gate would bounce them from.
 */
export function interviewDetailTrail(opts: {
  staff: boolean;
  cycleId: string;
  cycleTitle: string;
  candidate: string;
}): Crumb[] {
  const { staff, cycleId, cycleTitle, candidate } = opts;
  if (staff) {
    return cycleTrail({ cycleId, cycleTitle, section: { label: "Interviews", slug: "interviews" }, leaf: candidate });
  }
  return [HUB, { label: "My interviews", href: "/recruitment/interviews" }, { label: candidate }];
}
