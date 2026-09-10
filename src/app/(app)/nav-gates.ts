/**
 * Every `dynamicGate` nav item the global nav CAN be told about, in one list.
 *
 * `filterAccessibleModules` drops `dynamicGate` items unless the caller hands
 * back the hrefs it resolved, because the platform layer cannot evaluate a
 * data-driven gate and offering the link would risk a bounce to /no-access.
 * That is the right default and the wrong end state: it left real tabs
 * reachable from nowhere but their own module's tab row, invisible to the
 * module dropdown and to Cmd+K (which builds its candidates from nav labels).
 *
 * The list, rather than three hand-written calls in the layout, is what makes
 * the coverage guard in nav-dynamic-gates.test.ts mean something. The layout
 * resolves the union by mapping over this array, so a resolver that is declared
 * but never wired up is not a state this file can be in: adding the entry IS
 * wiring it up. A guard written against href constants alone could not tell the
 * difference, since every one of these constants already existed while the tab
 * was still invisible.
 *
 * Lives under src/app rather than src/platform because it names module
 * services, which platform code may not import.
 */

import {
  SCHEDULE_APPROVALS_HREF,
  SCHEDULE_ATTENDINGS_HREF,
  SCHEDULE_BUILDER_HREF,
  SCHEDULE_COVERAGE_HREF,
  SCHEDULE_CREDENTIALING_HREF,
  resolvedScheduleNavHrefs,
} from "@/modules/schedule/nav";
import { EVENTS_HREF, resolvedRecruitmentNavHrefs } from "@/modules/recruitment/nav";
import { DUAL_ROLE_QUEUE_PATH, resolvedVolunteersNavHrefs } from "@/modules/volunteers/nav";

export type NavGateResolver = {
  /** Every dynamicGate href this resolver decides. Its answer is a subset. */
  hrefs: readonly string[];
  resolve: (personId: string) => Promise<Set<string>>;
};

export const NAV_GATE_RESOLVERS: readonly NavGateResolver[] = [
  {
    hrefs: [
      SCHEDULE_BUILDER_HREF,
      SCHEDULE_ATTENDINGS_HREF,
      SCHEDULE_CREDENTIALING_HREF,
      SCHEDULE_COVERAGE_HREF,
      SCHEDULE_APPROVALS_HREF,
    ],
    resolve: resolvedScheduleNavHrefs,
  },
  { hrefs: [EVENTS_HREF], resolve: resolvedRecruitmentNavHrefs },
  { hrefs: [DUAL_ROLE_QUEUE_PATH], resolve: resolvedVolunteersNavHrefs },
];

/**
 * The dynamically-gated hrefs this person may open, across every module.
 *
 * `/schedule/check-in` is deliberately absent and stays the schedule layout's
 * decision: "is today a clinic day, and does this viewer have a shift on it"
 * needs three queries the assignment context does not cover, on every page in
 * the app, to decide a tab that is meaningful on roughly 30 days a year.
 */
export async function resolveNavGates(personId: string): Promise<Set<string>> {
  const resolved = await Promise.all(NAV_GATE_RESOLVERS.map((r) => r.resolve(personId)));
  return new Set(resolved.flatMap((hrefs) => [...hrefs]));
}
