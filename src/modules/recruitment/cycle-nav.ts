import type { TabItem } from "@/platform/ui/tab-row";

/**
 * Cycle workspace tab visibility, lifted verbatim from the gates in
 * src/app/(app)/recruitment/cycles/[id]/page.tsx (the button wall and the
 * Training card). The two must move together: any gate that changes on the
 * page needs the identical change made here, and vice versa, or a tab will
 * either dead-end on a page that refuses the viewer or hide a page the
 * viewer is actually allowed to open.
 *
 * Speed route (cycles/[id]/speed-route) is not linked from cycles/[id]/page.tsx
 * at all; it is included here anyway, gated on the page's own real
 * authorization rather than the applicants-page link's stricter condition.
 * See the comment on that entry below.
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
  // Speed route's real gate is recruitment.review_all (loadSpeedRouteBoard throws
  // RecruitmentAuthError otherwise, and the page turns that into notFound). The
  // applicants-page link additionally requires at least one committee score, but
  // that is a usefulness check, not authorization: a review_all holder with no
  // scores gets an empty board, which is a normal empty state.
  if (opts.canReviewAll && opts.track === "VOLUNTEER") {
    items.push({ label: "Speed route", href: `${base}/speed-route` });
  }
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
