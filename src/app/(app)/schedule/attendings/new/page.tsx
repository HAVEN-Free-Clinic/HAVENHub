import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  createAttending,
  manageableServiceLines,
  CAPABILITY_KEYS,
  AttendingValidationError,
  AttendingForbiddenError,
  type CapabilityValue,
} from "@/modules/schedule/services/attendings";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = {
  searchParams: Promise<{ line?: string; error?: string }>;
};

/** Reproductive health keeps the procedure matrix; no other line has one. */
const PROCEDURE_LINE_CODE = "SRHD";

export default async function NewAttendingPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  // The service line comes from the link on the roster page. It must be one the
  // actor may edit, resolved here rather than trusted from the query string, so
  // a hand-edited ?line= cannot add an attending to someone else's roster. The
  // service re-checks this too; this only decides what the page renders.
  const manageable = await manageableServiceLines(session.personId);
  if (manageable.length === 0) redirect("/no-access");

  const line = sp.line ? manageable.find((l) => l.id === sp.line) : manageable[0];
  if (!line) notFound();
  const lineId = line.id;

  async function createAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const capabilities: Record<string, CapabilityValue> = Object.fromEntries(
      CAPABILITY_KEYS.map((k) => [k, (formData.get(k) as string) as CapabilityValue]),
    );
    try {
      await createAttending(actor.personId, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        departmentId: lineId,
        capabilities,
        notes: (formData.get("notes") as string) || null,
      });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/new?line=${lineId}&error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule/attendings");
  }

  return (
    <div className="space-y-6">
      <PageHeader title={`Add attending to ${line.name}`} />
      <AttendingForm action={createAction} showCapabilities={line.code === PROCEDURE_LINE_CODE} />
    </div>
  );
}
