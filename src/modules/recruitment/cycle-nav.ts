import type { TabItem } from "@/platform/ui/tab-row";

/**
 * The workflow stage a cycle tab belongs to. The workspace used to be one row
 * of up to twelve tabs in no particular order (Emails and Quiz, both setup,
 * sat after Onboarding); the row now shows these four stages and, under them,
 * only the tabs of the stage you are in. Pages and URLs are unchanged: this is
 * purely how the existing tabs are arranged.
 */
export type CycleNavGroup = "setup" | "review" | "accepted" | "settings";

/** Stage order and labels, as the stage row draws them. */
export const CYCLE_NAV_GROUPS: readonly { key: CycleNavGroup; label: string }[] = [
  { key: "setup", label: "Setup" },
  { key: "review", label: "Review" },
  { key: "accepted", label: "Accepted" },
  // The cycle overview: title, departments, window, publish/close, training
  // setup. Everything on it is configuration, hence the stage's name.
  { key: "settings", label: "Settings" },
];

export type CycleNavItem = TabItem & { group: CycleNavGroup };

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
 *
 * The flat order is kept (Overview first) and each item carries its stage;
 * CycleNavTabs groups them, preserving this order within a stage.
 */
export function cycleNavItems(opts: {
  cycleId: string;
  track: "VOLUNTEER" | "DIRECTOR";
  canAccess: boolean; // recruitment.access
  canManage: boolean; // recruitment.manage_cycles
  canReviewAll: boolean; // recruitment.review_all
}): CycleNavItem[] {
  const base = `/recruitment/cycles/${opts.cycleId}`;
  const items: CycleNavItem[] = [];
  if (opts.canAccess) items.push({ label: "Overview", href: base, group: "settings" });
  if (opts.canAccess && opts.canManage) items.push({ label: "Form", href: `${base}/builder`, group: "setup" });
  if (opts.canAccess && opts.canManage) items.push({ label: "Contract", href: `${base}/builder/contract`, group: "setup" });
  // Applicants has no recruitment.access check: it self-authorizes by review
  // scope (listApplicantsForReview), so it stays visible without canAccess.
  items.push({ label: "Applicants", href: `${base}/applicants`, group: "review" });
  // Speed route's real gate is recruitment.review_all (loadSpeedRouteBoard throws
  // RecruitmentAuthError otherwise, and the page turns that into notFound). The
  // page has no recruitment.access check either. The applicants-page link
  // additionally requires at least one committee score, but that is a
  // usefulness check, not authorization: a review_all holder with no scores
  // gets an empty board, which is a normal empty state.
  if (opts.canReviewAll && opts.track === "VOLUNTEER") {
    items.push({ label: "Speed route", href: `${base}/speed-route`, group: "review" });
  }
  if (opts.canAccess) items.push({ label: "Waitlist", href: `${base}/waitlist`, group: "review" });
  if (opts.canAccess && opts.canReviewAll) items.push({ label: "Decisions", href: `${base}/decisions`, group: "review" });
  if (opts.canAccess && opts.track === "VOLUNTEER" && (opts.canReviewAll || opts.canManage)) {
    items.push({ label: "Subcommittees", href: `${base}/subcommittees`, group: "accepted" });
  }
  // DIRECTOR-only is correct, not an oversight: scheduleInterview rejects any
  // other track outright ("Interviews apply to director cycles.", see
  // services/interviews.ts), so a VOLUNTEER cycle can never have an interview to
  // show. Volunteer applications are reviewed by committee scoring and
  // department routing instead. Do not widen this to make the tab "available".
  if (opts.canAccess && opts.track === "DIRECTOR") items.push({ label: "Interviews", href: `${base}/interviews`, group: "review" });
  if (opts.canAccess && opts.canReviewAll) items.push({ label: "Onboarding", href: `${base}/onboarding`, group: "accepted" });
  if (opts.canAccess && opts.canManage) items.push({ label: "Emails", href: `${base}/emails`, group: "setup" });
  if (opts.canAccess && opts.canManage) items.push({ label: "Quiz", href: `${base}/builder/quiz`, group: "setup" });
  if (opts.canAccess) items.push({ label: "Training", href: `${base}/training`, group: "accepted" });
  return items;
}
