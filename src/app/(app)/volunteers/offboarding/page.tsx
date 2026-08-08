import { requirePermission } from "@/platform/auth/session";
import { captureEvent } from "@/platform/posthog/capture";
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

// The volunteers layout gates module access. Here we additionally require
// volunteers.view for the page render and use volunteers.manage_offboarding
// defense-in-depth in the execute action, matching /volunteers/page.tsx pattern.

const BASE = "/volunteers/offboarding";

// Task 6 widens this with "transition" when it adds that tab.
type OffboardingTab = "departments" | "flagged";

export default async function OffboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; error?: string }>;
}) {
  const viewer = await requirePermission("volunteers.view");
  const { tab: rawTab } = await searchParams;

  const { departments, flagged } = await offboardingView(viewer.personId);

  // Task 6 adds the Transition tab and makes it the default during a rollover.
  // This task is a pure refactor, so the landing tab stays the department cards
  // the page has always opened on.
  const requested = rawTab as OffboardingTab | undefined;
  const tab: OffboardingTab =
    requested === "departments" || requested === "flagged" ? requested : "departments";

  const items = [
    { label: "By department", href: `${BASE}?tab=departments` },
    // The flagged queue is executor-only, exactly as the old inline section was:
    // offboardingView returns null for a viewer without manage_offboarding.
    ...(flagged !== null ? [{ label: "Flagged", href: `${BASE}?tab=flagged` }] : []),
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
        />
      )}

    </div>
  );
}
