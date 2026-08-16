import { requirePermission } from "@/platform/auth/session";
import { captureEvent, flushEvents } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import { PageHeader } from "@/platform/ui/page-header";
import { TabRow } from "@/platform/ui/tab-row";
import {
  offboardingView,
  flagForOffboarding,
  unflag,
  executeOffboard,
  OffboardForbiddenError,
  OffboardNotFoundError,
} from "@/modules/volunteers/services/offboarding";
import { DepartmentTab } from "@/modules/volunteers/components/department-tab";
import { FlaggedTab } from "@/modules/volunteers/components/flagged-tab";
import { LastAdminError } from "@/platform/rbac/last-admin";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { transitionView } from "@/modules/volunteers/services/transition";
import {
  bulkFlag,
  bulkExecuteOffboard,
  TransitionBatchTooLargeError,
  type BulkResult,
} from "@/modules/volunteers/services/transition-actions";
import { TransitionTab } from "@/modules/volunteers/components/transition-tab";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getNextTerm } from "@/platform/terms/next-term";
import { can } from "@/platform/rbac/engine";

// The volunteers layout gates module access. Here we additionally require
// volunteers.view for the page render and use volunteers.manage_offboarding
// defense-in-depth in the execute action, matching /volunteers/page.tsx pattern.

const BASE = "/volunteers/offboarding";

type OffboardingTab = "transition" | "departments" | "flagged";

export default async function OffboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; error?: string }>;
}) {
  const viewer = await requirePermission("volunteers.view");
  const { tab: rawTab } = await searchParams;

  const [nextTerm, canExecute, activeTerm] = await Promise.all([
    getNextTerm(),
    can(viewer.personId, "volunteers.manage_offboarding"),
    getActiveTerm(),
  ]);

  // Default to the transition report while a term is being prepared, and to the
  // department cards the rest of the year, so the page opens where it always has
  // when no rollover is in progress.
  const fallback: OffboardingTab = nextTerm ? "transition" : "departments";
  const requested = rawTab as OffboardingTab | undefined;
  const tab: OffboardingTab =
    requested === "transition" || requested === "departments" || requested === "flagged"
      ? requested
      : fallback;

  // Only the active tab's data is queried: the Transition tab has its own
  // roll-up (transitionView) below and never needs offboardingView's
  // department cards or flagged queue, so a director opening Transition
  // during a rollover, now the default tab, does not pay for that query.
  const { departments, flagged } =
    tab === "transition" ? { departments: [], flagged: null } : await offboardingView(viewer.personId);
  const transition = tab === "transition" ? await transitionView(viewer.personId) : null;

  const items = [
    { label: "Transition", href: `${BASE}?tab=transition` },
    { label: "By department", href: `${BASE}?tab=departments` },
    // The flagged queue is executor-only AND active-term-only: offboardingView
    // returns flagged: null both for a viewer without manage_offboarding and
    // whenever there is no ACTIVE term, so flagged !== null is not the same
    // check as canExecute alone. Gating on canExecute alone would offer an
    // empty Flagged tab out of season (an executor, but no active term).
    ...(canExecute && activeTerm ? [{ label: "Flagged", href: `${BASE}?tab=flagged` }] : []),
  ];

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function flagAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personId = formData.get("personId") as string;
    const note = (formData.get("note") as string | null) || undefined;
    if (!personId) return;
    // Unlike unflagAction, flagAction is only ever bound from the Departments
    // tab (DepartmentTab), so a fixed redirect target is correct here; there is
    // no second origin to preserve.
    try {
      await flagForOffboarding(actor.personId, personId, note);
    } catch (err) {
      if (err instanceof OffboardForbiddenError) {
        redirect(`${BASE}?tab=departments&error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(BASE);
  }

  async function unflagAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personId = formData.get("personId") as string;
    if (!personId) return;
    // unflagAction is bound from both tabs (a director unflags from Departments,
    // an executor unflags from the Flagged queue), so an error must redirect back
    // to whichever tab the form was submitted from, not always Departments. The
    // form tells us via a hidden "tab" input; validate against the known tab
    // names rather than interpolating the raw value into the redirect target.
    const requestedTab = formData.get("tab") as string | null;
    const originTab: OffboardingTab =
      requestedTab === "departments" || requestedTab === "flagged" ? requestedTab : "departments";
    try {
      await unflag(actor.personId, personId);
    } catch (err) {
      if (err instanceof OffboardForbiddenError || err instanceof OffboardNotFoundError) {
        redirect(`${BASE}?tab=${originTab}&error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(BASE);
  }

  async function executeOffboardAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_offboarding");
    const personId = formData.get("personId") as string;
    if (!personId) return;
    try {
      await executeOffboard(actor.personId, personId);
      await captureEvent({
        distinctId: actor.personId,
        event: "volunteer_offboarded",
        properties: { offboarded_person_id: personId },
        groups: await activeTermGroup(),
      });
    } catch (err) {
      // #92: executeOffboard's last-admin guard throws LastAdminError; without this
      // it escaped to the error boundary as a 500 instead of the page's inline
      // amber alert. Mirror admin/people/[id]/page.tsx, which already catches it.
      if (err instanceof OffboardForbiddenError || err instanceof LastAdminError) {
        redirect(`${BASE}?tab=flagged&error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(BASE);
  }

  async function bulkFlagAction(
    _prev: BulkResult | null,
    formData: FormData
  ): Promise<BulkResult | null> {
    "use server";
    const actor = await requirePermission("volunteers.view");
    const personIds = formData.getAll("personId").map(String).filter(Boolean);
    const note = (formData.get("note") as string | null)?.trim() || undefined;
    if (personIds.length === 0) return null;

    const result = await bulkFlag(actor.personId, personIds, note);
    revalidatePath(BASE);
    return result;
  }

  async function bulkOffboardAction(
    _prev: BulkResult | null,
    formData: FormData
  ): Promise<BulkResult | null> {
    "use server";
    const actor = await requirePermission("volunteers.manage_offboarding");
    const personIds = formData.getAll("personId").map(String).filter(Boolean);
    if (personIds.length === 0) return null;

    let result: BulkResult;
    try {
      result = await bulkExecuteOffboard(actor.personId, personIds);
    } catch (err) {
      // The cap is enforced in the service too, so a client that bypasses the
      // disabled button still gets a readable answer rather than a 500.
      if (err instanceof TransitionBatchTooLargeError) {
        return {
          succeeded: [],
          skipped: personIds.map((personId) => ({ personId, name: "Selection", reason: err.message })),
        };
      }
      throw err;
    }

    // Analytics per person, matching the single-person execute action. Each
    // capture skips its own flush (flush: false) so a 25-person batch does not
    // pay for 25 sequential bounded flushes (up to 3000ms each); one
    // flushEvents() after the loop drains the whole batch instead. Matches the
    // pattern in shift-reminders.ts, enrollment.ts, and promotion.ts.
    const groups = await activeTermGroup();
    for (const person of result.succeeded) {
      await captureEvent({
        distinctId: actor.personId,
        event: "volunteer_offboarded",
        properties: { offboarded_person_id: person.personId, bulk: true },
        groups,
        flush: false,
      });
    }
    if (result.succeeded.length > 0) await flushEvents();

    revalidatePath(BASE);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <PageHeader
        title="Offboarding"
        description="Flag and process volunteer offboarding."
      />

      <div className="mt-6">
        <TabRow
          items={items}
          label="Offboarding sections"
          isActive={(item) => item.href === `${BASE}?tab=${tab}`}
        />
      </div>

      {tab === "transition" && transition && (
        <TransitionTab
          view={transition}
          canExecute={canExecute}
          bulkFlagAction={bulkFlagAction}
          bulkOffboardAction={bulkOffboardAction}
        />
      )}

      {tab === "departments" && (
        <DepartmentTab
          departments={departments}
          flagAction={flagAction}
          unflagAction={unflagAction}
        />
      )}

      {tab === "flagged" && flagged !== null && (
        <FlaggedTab
          flagged={flagged}
          unflagAction={unflagAction}
          executeOffboardAction={executeOffboardAction}
          bulkOffboardAction={bulkOffboardAction}
        />
      )}
    </div>
  );
}
