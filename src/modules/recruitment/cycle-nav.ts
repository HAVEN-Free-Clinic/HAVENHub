import type { TabItem } from "@/platform/ui/tab-row";

/**
 * Cycle workspace tab visibility, lifted verbatim from the gates in
 * src/app/(app)/recruitment/cycles/[id]/page.tsx (the button wall and the
 * Training card). The two must move together: any gate that changes on the
 * page needs the identical change made here, and vice versa, or a tab will
 * either dead-end on a page that refuses the viewer or hide a page the
 * viewer is actually allowed to open.
 *
 * Deliberately NOT included: the Speed route sub-page
 * (cycles/[id]/speed-route). It is never linked from cycles/[id]/page.tsx at
 * all; its only entry point is cycles/[id]/applicants/page.tsx, gated on
 * `scope.all && cycle.track === "VOLUNTEER" && apps.some(a =>
 * a.committeeScores.length > 0)`, a dynamic, data-dependent condition this
 * function's static canManage/canReviewAll booleans cannot express. Adding
 * it here as an always-on tab would dead-end DIRECTOR-track cycles,
 * non-scope.all reviewers, and VOLUNTEER cycles with no scored applicants
 * yet on a 404. Whoever wires this into the tab row needs to either thread
 * the real condition through as a third input or leave the tab out.
 */
export function cycleNavItems(opts: {
  cycleId: string;
  track: "VOLUNTEER" | "DIRECTOR";
  canManage: boolean; // recruitment.manage_cycles
  canReviewAll: boolean; // recruitment.review_all
}): TabItem[] {
  const base = `/recruitment/cycles/${opts.cycleId}`;
  const items: TabItem[] = [{ label: "Overview", href: base }];
  if (opts.canManage) items.push({ label: "Form", href: `${base}/builder` });
  if (opts.canManage) items.push({ label: "Contract", href: `${base}/builder/contract` });
  items.push({ label: "Applicants", href: `${base}/applicants` });
  items.push({ label: "Waitlist", href: `${base}/waitlist` });
  if (opts.canReviewAll) items.push({ label: "Decisions", href: `${base}/decisions` });
  if (opts.track === "VOLUNTEER" && (opts.canReviewAll || opts.canManage)) {
    items.push({ label: "Subcommittees", href: `${base}/subcommittees` });
  }
  if (opts.track === "DIRECTOR") items.push({ label: "Interviews", href: `${base}/interviews` });
  if (opts.canReviewAll) items.push({ label: "Onboarding", href: `${base}/onboarding` });
  if (opts.canManage) items.push({ label: "Emails", href: `${base}/emails` });
  if (opts.canManage) items.push({ label: "Quiz", href: `${base}/builder/quiz` });
  items.push({ label: "Training", href: `${base}/training` });
  return items;
}
