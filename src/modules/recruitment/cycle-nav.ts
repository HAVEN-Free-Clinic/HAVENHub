import type { TabItem } from "@/platform/ui/tab-row";

/**
 * Cycle workspace tab visibility, lifted verbatim from the gates in
 * src/app/(app)/recruitment/cycles/[id]/page.tsx (the button wall and the
 * Training card) and from every cycle sub-page's own permission check. The
 * two must move together: any gate that changes on a page needs the
 * identical change made here, and vice versa, or a tab will either dead-end
 * on a page that refuses the viewer or hide a page the viewer is actually
 * allowed to open.
 *
 * The gates STACK. requireRecruitmentStaff (recruitment/cycles/access.ts)
 * admits anyone with recruitment.access, recruitment.score (committee
 * scorers), or a review scope, so a committee scorer legitimately enters the
 * cycle subtree while holding NONE of this function's other booleans. But
 * nearly every sub-page then calls requirePermission("recruitment.access")
 * first, before its finer-grained check (manage_cycles / review_all) -- so a
 * tab whose page requires recruitment.access needs canAccess AND that finer
 * permission, not just the finer permission alone. Applicants and Speed
 * route are the two exceptions: neither page checks recruitment.access at
 * all (Applicants self-authorizes by review scope; Speed route's only check
 * is review_all inside loadSpeedRouteBoard), so they are deliberately left
 * out of the canAccess requirement below. Comment preserved on each so the
 * asymmetry reads as intentional.
 */
export function cycleNavItems(opts: {
  cycleId: string;
  track: "VOLUNTEER" | "DIRECTOR";
  canAccess: boolean; // recruitment.access
  canManage: boolean; // recruitment.manage_cycles
  canReviewAll: boolean; // recruitment.review_all
}): TabItem[] {
  const base = `/recruitment/cycles/${opts.cycleId}`;
  const items: TabItem[] = [];
  if (opts.canAccess) items.push({ label: "Overview", href: base });
  if (opts.canAccess && opts.canManage) items.push({ label: "Form", href: `${base}/builder` });
  if (opts.canAccess && opts.canManage) items.push({ label: "Contract", href: `${base}/builder/contract` });
  // Applicants has no recruitment.access check: it self-authorizes by review
  // scope (listApplicantsForReview), so it stays visible without canAccess.
  items.push({ label: "Applicants", href: `${base}/applicants` });
  // Speed route's real gate is recruitment.review_all (loadSpeedRouteBoard throws
  // RecruitmentAuthError otherwise, and the page turns that into notFound). The
  // page has no recruitment.access check either. The applicants-page link
  // additionally requires at least one committee score, but that is a
  // usefulness check, not authorization: a review_all holder with no scores
  // gets an empty board, which is a normal empty state.
  if (opts.canReviewAll && opts.track === "VOLUNTEER") {
    items.push({ label: "Speed route", href: `${base}/speed-route` });
  }
  if (opts.canAccess) items.push({ label: "Waitlist", href: `${base}/waitlist` });
  if (opts.canAccess && opts.canReviewAll) items.push({ label: "Decisions", href: `${base}/decisions` });
  if (opts.canAccess && opts.track === "VOLUNTEER" && (opts.canReviewAll || opts.canManage)) {
    items.push({ label: "Subcommittees", href: `${base}/subcommittees` });
  }
  // DIRECTOR-only is correct, not an oversight: scheduleInterview rejects any
  // other track outright ("Interviews apply to director cycles.", see
  // services/interviews.ts), so a VOLUNTEER cycle can never have an interview to
  // show. Volunteer applications are reviewed by committee scoring and
  // department routing instead. Do not widen this to make the tab "available".
  if (opts.canAccess && opts.track === "DIRECTOR") items.push({ label: "Interviews", href: `${base}/interviews` });
  if (opts.canAccess && opts.canReviewAll) items.push({ label: "Onboarding", href: `${base}/onboarding` });
  if (opts.canAccess && opts.canManage) items.push({ label: "Emails", href: `${base}/emails` });
  if (opts.canAccess && opts.canManage) items.push({ label: "Quiz", href: `${base}/builder/quiz` });
  if (opts.canAccess) items.push({ label: "Training", href: `${base}/training` });
  return items;
}
