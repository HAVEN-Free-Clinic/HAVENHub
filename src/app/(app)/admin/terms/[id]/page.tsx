import { notFound, redirect } from "next/navigation";
import { requirePermission, requireAnyPermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import {
  activateTerm,
  archiveTerm,
  updateClinicDates,
  saturdaysBetween,
  TermNotFoundError,
  TermNotActivatableError,
  TermDateError,
} from "@/modules/admin/services/terms";
import {
  setClinicDayClosure,
  BuilderValidationError,
  BuilderForbiddenError,
} from "@/modules/schedule/services/builder";
import { prisma } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { SectionHeader } from "@/platform/ui/section-header";
import { ClinicDatesEditor } from "@/modules/admin/components/clinic-dates-editor";
import { RosterPanel } from "@/modules/admin/components/roster-panel";
import { OnboardingStepsEditor } from "@/modules/onboarding/components/onboarding-steps-editor";
import {
  listStepConfig,
  setStepConfig,
  ONBOARDING_STEP_KINDS,
  STEP_DEFAULTS,
} from "@/modules/onboarding/services/step-config";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    addq?: string;
  }>;
};

export default async function TermDetailPage({ params, searchParams }: PageProps) {
  const session = await requireAnyPermission(["admin.manage_terms", "admin.manage_roster"]);
  const canManageTerms = await can(session.personId, "admin.manage_terms");
  const { id } = await params;
  const { addq } = await searchParams;

  // Fetch the term with membership count. Scope to ACTIVE so the header number
  // matches the ACTIVE-only roster rendered below it (memberships are soft-deleted).
  const term = await prisma.term.findUnique({
    where: { id },
    include: { _count: { select: { memberships: { where: { status: "ACTIVE" } } } } },
  });
  if (!term) notFound();

  // Closure lives on ClinicDay, not on Term.clinicDates, so the editor needs both.
  // Rows are sparse -- a term routinely has more clinic dates than day rows -- so
  // a missing entry means "open", not "missing data".
  const clinicDayRows = await prisma.clinicDay.findMany({
    where: { termId: id },
    select: { clinicDate: true, isClosed: true, closedNote: true },
  });
  const closures: Record<string, { isClosed: boolean; closedNote: string | null }> =
    Object.fromEntries(
      clinicDayRows.map((r) => [
        isoDateKey(r.clinicDate),
        { isClosed: r.isClosed, closedNote: r.closedNote },
      ])
    );

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

  // Effective onboarding steps for the editor (defaults + this term's overrides).
  const stepConfig = canManageTerms ? await listStepConfig(id) : [];

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
      const message =
        err instanceof TermNotActivatableError ? err.message : "Failed to activate term.";
      redirect(`/admin/terms/${id}?error=${encodeURIComponent(message)}`);
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

  /** Declare or clear one date's closure. Admin owns closure; Faculty Relations reads it. */
  async function closureAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_terms");
    const dateKey = String(formData.get("dateKey") ?? "");
    // Safe to read a missing field as "open" here, unlike the attendings form
    // this replaces: that one shared a single form across the whole day, so an
    // absent isClosed could not be told from a form that never rendered the
    // control. This form is per-date and always renders it, so unchecked is
    // unambiguously open.
    const isClosed = formData.get("isClosed") === "on";
    const closedNote = String(formData.get("closedNote") ?? "");

    try {
      await setClinicDayClosure(actorSession.personId, {
        termId: id,
        dateKey,
        isClosed,
        closedNote,
      });
    } catch (err) {
      const message =
        err instanceof BuilderValidationError || err instanceof BuilderForbiddenError
          ? err.message
          : "Failed to update the closure.";
      redirect(`/admin/terms/${id}?error=${encodeURIComponent(message)}`);
    }
    redirect(`/admin/terms/${id}?saved=1`);
  }

  async function saveStepsAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_terms");
    for (const kind of ONBOARDING_STEP_KINDS) {
      const enabled = formData.get(`step.${kind}.enabled`) === "on";
      const blocking = formData.get(`step.${kind}.blocking`) === "on";
      const labelRaw = ((formData.get(`step.${kind}.label`) as string) ?? "").trim();
      const orderRaw = parseInt((formData.get(`step.${kind}.order`) as string) ?? "", 10);
      await setStepConfig(actorSession.personId, id, kind, {
        enabled,
        // Empty or default-matching label keeps the built-in copy (no override stored).
        label: labelRaw === "" || labelRaw === STEP_DEFAULTS[kind].label ? null : labelRaw,
        blocking,
        order: Number.isFinite(orderRaw) ? orderRaw : STEP_DEFAULTS[kind].order,
      });
    }
    redirect(`/admin/terms/${id}?stepsSaved=1`);
  }

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

      {/* Lifecycle section */}
      {canManageTerms && (
        <section>
          <SectionHeader className="mb-4">Lifecycle</SectionHeader>
          {term.status === "ACTIVE" ? (
            <form action={archiveAction}>
              <p className="mb-3 text-sm text-muted-foreground">
                Archiving this term will leave no active term. The engine handles the
                no-active-term state gracefully. Any still-pending shift requests for
                this term are cancelled.
              </p>
              <ConfirmButton label="Archive" confirmLabel="Archive this term? Confirm?" />
            </form>
          ) : term.status === "PLANNING" ? (
            <form action={activateAction}>
              <p className="mb-3 text-sm text-muted-foreground">{activateLabel}</p>
              <ConfirmButton label="Activate" confirmLabel={activateConfirmLabel} />
            </form>
          ) : (
            // ARCHIVED: terminal. Activation is refused server-side, so offer no
            // button; a mis-flipped term is recovered by re-activating the one
            // that was demoted to Planning, not by resurrecting this one.
            <p className="text-sm text-muted-foreground">
              This term is archived. Archiving is terminal, so it cannot be reactivated.
            </p>
          )}
        </section>
      )}

      {/* Clinic dates section */}
      {canManageTerms && (
        <section>
          <SectionHeader className="mb-4">Clinic dates</SectionHeader>
          <p className="mb-4 text-sm text-muted-foreground">
            {term.clinicDates.length} date(s) scheduled. These are calendar dates with no time of day, so they read the same in every time zone.
          </p>
          <ClinicDatesEditor
            termId={id}
            clinicDates={term.clinicDates}
            saturdayIsos={saturdayIsos}
            updateAction={clinicDatesAction}
            closures={closures}
            closureAction={closureAction}
          />
        </section>
      )}

      {/* Onboarding steps section */}
      {canManageTerms && (
        <section>
          <SectionHeader className="mb-4">Onboarding steps</SectionHeader>
          <OnboardingStepsEditor
            steps={stepConfig}
            saveAction={saveStepsAction}
          />
        </section>
      )}

      {/* Roster panel */}
      <RosterPanel
        term={term}
        addq={addq}
        termDetailHref={`/admin/terms/${id}`}
        canManage={await can(session.personId, "admin.manage_roster")}
      />
    </div>
  );
}
