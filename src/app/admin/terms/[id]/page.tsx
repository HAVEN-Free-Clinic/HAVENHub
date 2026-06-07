import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  activateTerm,
  archiveTerm,
  updateClinicDates,
  saturdaysBetween,
  TermNotFoundError,
  TermDateError,
} from "@/modules/admin/services/terms";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { ClinicDatesEditor } from "@/modules/admin/components/clinic-dates-editor";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function TermDetailPage({ params, searchParams }: PageProps) {
  await requirePermission("admin.manage_terms");
  const { id } = await params;
  const { error, saved } = await searchParams;

  // Fetch the term with membership count.
  const term = await prisma.term.findUnique({
    where: { id },
    include: { _count: { select: { memberships: true } } },
  });
  if (!term) notFound();

  // Find the currently active term (if any, and different from this one) so we
  // can explain the activate swap in the ConfirmButton label.
  const currentActive =
    term.status !== "ACTIVE"
      ? await prisma.term.findFirst({
          where: { status: "ACTIVE" },
          orderBy: { startDate: "desc" },
        })
      : null;

  // Pre-compute the Saturdays for "Regenerate Saturdays".
  const termStartIso = term.startDate.toISOString().slice(0, 10);
  const termEndIso = term.endDate.toISOString().slice(0, 10);
  const saturdayIsos = saturdaysBetween(termStartIso, termEndIso).map((d) =>
    d.toISOString().slice(0, 10)
  );

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function activateAction() {
    "use server";
    const actorSession = await requirePermission("admin.manage_terms");
    try {
      await activateTerm(actorSession.personId, id);
    } catch (err) {
      if (err instanceof TermNotFoundError) notFound();
      redirect(
        `/admin/terms/${id}?error=${encodeURIComponent("Failed to activate term.")}`
      );
    }
    redirect(`/admin/terms/${id}?saved=1`);
  }

  async function archiveAction() {
    "use server";
    const actorSession = await requirePermission("admin.manage_terms");
    try {
      await archiveTerm(actorSession.personId, id);
    } catch (err) {
      if (err instanceof TermNotFoundError) notFound();
      redirect(
        `/admin/terms/${id}?error=${encodeURIComponent("Failed to archive term.")}`
      );
    }
    redirect(`/admin/terms/${id}?saved=1`);
  }

  async function clinicDatesAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_terms");

    let datesIso: string[];

    try {
      // Parse the hidden "dates" JSON field safely; tampered input -> TermDateError.
      function parseDatesField(raw: string | null): string[] {
        if (!raw) return [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new TermDateError(raw);
        }
        if (!Array.isArray(parsed)) throw new TermDateError(raw);
        return parsed.map(String);
      }

      const regenerate = formData.get("regenerate");
      const addDateRaw = formData.get("addDate") as string | null;

      if (regenerate === "1") {
        // Use the pre-serialized Saturdays passed from the hidden field.
        datesIso = parseDatesField(formData.get("dates") as string | null);
      } else if (addDateRaw && addDateRaw.trim() !== "") {
        // Add a new date to the existing list.
        const existing = parseDatesField(formData.get("dates") as string | null);
        datesIso = [...existing, addDateRaw.trim()];
      } else {
        // Remove operation: "dates" contains the remaining list.
        datesIso = parseDatesField(formData.get("dates") as string | null);
      }

      // Use the closure `id` directly; do not trust the formData termId field.
      await updateClinicDates(actorSession.personId, id, datesIso);
    } catch (err) {
      if (err instanceof TermDateError) {
        redirect(
          `/admin/terms/${id}?error=${encodeURIComponent(`Invalid date: ${err.input}`)}`
        );
      }
      if (err instanceof TermNotFoundError) notFound();
      throw err;
    }

    redirect(`/admin/terms/${id}`);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const statusBadge =
    term.status === "ACTIVE" ? (
      <Badge tone="brand">Active</Badge>
    ) : term.status === "PLANNING" ? (
      <Badge tone="default">Planning</Badge>
    ) : (
      <Badge tone="warning">Archived</Badge>
    );

  const activateLabel =
    currentActive
      ? `Activate (archives ${currentActive.code} and makes ${term.code} the active term)`
      : `Activate ${term.code}`;

  const activateConfirmLabel =
    currentActive
      ? `Archives ${currentActive.code} and makes ${term.code} active. Confirm?`
      : `Make ${term.code} the active term. Confirm?`;

  return (
    <div className="space-y-10">
      <PageHeader
        title={term.name}
        description={`${term.code} · ${term._count.memberships} member(s)`}
        action={statusBadge}
      />

      {error && (
        <p
          role="alert"
          className="rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {error}
        </p>
      )}
      {saved === "1" && (
        <p className="text-sm text-success">Saved.</p>
      )}

      {/* Lifecycle section */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Lifecycle
        </h2>
        {term.status === "ACTIVE" ? (
          <form action={archiveAction}>
            <p className="mb-3 text-sm text-slate-500">
              Archiving this term will leave no active term. The engine handles the
              no-active-term state gracefully.
            </p>
            <ConfirmButton label="Archive" confirmLabel="Archive this term? Confirm?" />
          </form>
        ) : (
          <form action={activateAction}>
            <p className="mb-3 text-sm text-slate-500">{activateLabel}</p>
            <ConfirmButton label="Activate" confirmLabel={activateConfirmLabel} />
          </form>
        )}
      </section>

      {/* Clinic dates section */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Clinic dates
        </h2>
        <p className="mb-4 text-sm text-slate-500">
          {term.clinicDates.length} date(s) scheduled. All dates are stored and rendered in UTC.
        </p>
        <ClinicDatesEditor
          termId={id}
          clinicDates={term.clinicDates}
          saturdayIsos={saturdayIsos}
          updateAction={clinicDatesAction}
        />
      </section>

      {/* Roster placeholder (lands in Task 8) */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mt-10">Roster</h2>
      <p className="mt-2 text-sm text-slate-400">Roster management lands in the next task.</p>
    </div>
  );
}
