import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { listCycles } from "@/modules/recruitment/services/cycles";
import { getActiveTerm } from "@/platform/terms/active-term";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { createEventAction } from "../actions";
import { KIND_LABELS } from "../kind-labels";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Add event",
    description: "Create a training session, info session or other event to take attendance at.",
  });
}

export default async function NewEventPage() {
  const viewer = await requirePersonSession();
  // One gate, not the list page's pair. /recruitment/events gates first on
  // canRecordAttendance (which admits a department director by review scope) and
  // then gates the form itself on recruitment.manage_cycles. Here only the form
  // exists, and resolveAttendanceAuthority already folds manage_cycles into
  // `all`, so manage_cycles implies canRecordAttendance: repeating the first
  // gate would exclude nobody the second one admits.
  if (!(await can(viewer.personId, "recruitment.manage_cycles"))) redirect("/no-access");

  // Unconditional, unlike the list page's `canManage ? await listCycles() : []`:
  // this page is the form, and everyone who reaches it may see the picker.
  const [term, cycles] = await Promise.all([getActiveTerm(), listCycles()]);

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Add event"
        description="Training sessions, info sessions and other events you can take attendance at."
      />

      {/* Moved here from the list page: it is a caveat about creating an event,
          not about reading the list, so it belongs beside the field it is about. */}
      {!term && (
        <Alert tone="warning">
          No term is active, so new events have to be attached to a recruitment cycle.
        </Alert>
      )}

      {/* No inline Alert: FlashReader claims this param, toasts it, and strips it
          from the URL, so an inline branch reported it twice and then lost its
          value on the router.replace. Error toasts do not auto-dismiss. */}
      <Card>
        <form action={createEventAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" required>
              <Input name="title" required placeholder="Fall 2026 info session" />
            </Field>
            <Field label="Kind" required>
              <Select name="kind" required defaultValue="INFO_SESSION">
                <option value="INFO_SESSION">{KIND_LABELS.INFO_SESSION}</option>
                <option value="TRAINING">{KIND_LABELS.TRAINING}</option>
                <option value="OTHER">{KIND_LABELS.OTHER}</option>
              </Select>
            </Field>
            <Field label="Starts" required>
              <Input type="datetime-local" name="startsAt" required />
            </Field>
            <Field label="Ends" hint="Optional.">
              <Input type="datetime-local" name="endsAt" />
            </Field>
            <Field
              label="Recruitment cycle"
              hint="Required for a training session: its cycle is what decides which track the attendance completes training for."
            >
              <Select name="cycleId" defaultValue="">
                <option value="">No cycle</option>
                {cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Location">
              <Input name="location" placeholder="SHM L110" />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea name="notes" rows={2} />
          </Field>
          <SubmitButton pendingLabel="Creating…">Create event</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
