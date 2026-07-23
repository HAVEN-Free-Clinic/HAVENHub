/**
 * Strikes ledger page for Incident Reports.
 *
 * Access: requirePermission("incidents.view_strikes"). Directors hold this
 * permission and can view but not issue or delete; central reviewers hold
 * incidents.manage and can issue and delete.
 *
 * Visibility is enforced by the service (listActions / issuablePeople).
 * A DisciplinaryForbiddenError from listActions is caught here and renders
 * a friendly empty state instead of a hard error.
 *
 * Server actions:
 *   issueActionForm  -- re-checks incidents.view_strikes, then requires
 *                        incidents.manage (directors issue strikes via a
 *                        report request, not here).
 *   deleteActionForm -- re-checks incidents.manage.
 */

import { requirePermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button, buttonClasses } from "@/platform/ui/button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { NavForm } from "@/platform/ui/nav-form";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { Combobox } from "@/platform/ui/combobox";
import {
  issueAction,
  deleteAction,
  listActions,
  issuablePeople,
  strikeablePeople,
  linkActionToReport,
  DISCIPLINARY_CATEGORIES,
  DisciplinaryForbiddenError,
  DisciplinaryNotFoundError,
  DisciplinaryValidationError,
} from "@/modules/incidents/services/disciplinary";
import { linkableReports } from "@/modules/incidents/services/report";
import { notifyStrikeIssued } from "@/modules/incidents/services/strike-notifications";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { DisciplinaryAction } from "@prisma/client";
import { StrikeRow } from "./strike-row";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateOnly } from "@/platform/dates";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for that action.",
  "not-found": "The disciplinary action could not be found.",
  "bad-category": "Invalid category. Please select a valid category.",
  "blank-description": "Description must not be blank.",
  "future-date": "Occurred date must not be in the future.",
  "person-not-found": "Person not found. Search and select a person from the list, then try again.",
  "validation": "Please check your input and try again.",
};

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{
    q?: string;
    departmentId?: string;
    category?: string;
    page?: string;
    error?: string;
    message?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DisciplinaryPage({ searchParams }: PageProps) {
  const viewer = await requirePermission("incidents.view_strikes");
  const sp = await searchParams;

  const qSearch = sp.q?.trim() || undefined;
  const departmentId = sp.departmentId || undefined;
  const categoryFilter = sp.category || undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const errorCode = sp.error ?? null;
  // When error=validation the action encodes the raw message in ?message=.
  // All other unknown codes fall back to a generic string (never expose raw
  // encoded content that could confuse users or leak internals).
  const errorMessage = errorCode
    ? errorCode === "validation" && sp.message
      ? decodeURIComponent(sp.message)
      : (ERROR_MESSAGES[errorCode] ?? "An unexpected error occurred.")
    : null;

  // Load the pickers for the issue form. strikeablePeople and linkableReports
  // are central-only and return empty / throw for directors, so only fetch them
  // when the viewer actually holds incidents.manage.
  const isCentral = await can(viewer.personId, "incidents.manage");
  const [issuable, searchablePeople, reportOptions] = await Promise.all([
    issuablePeople(viewer.personId),
    isCentral ? strikeablePeople(viewer.personId) : Promise.resolve([]),
    isCentral ? linkableReports(viewer.personId) : Promise.resolve([]),
  ]);

  const displayZone = await getDisplayTimeZone();

  // Load actions; catch Forbidden to render a friendly empty state.
  let listResult: Awaited<ReturnType<typeof listActions>> | null = null;
  let accessForbidden = false;
  try {
    listResult = await listActions(viewer.personId, {
      q: qSearch,
      departmentId,
      category: categoryFilter,
      page,
    });
  } catch (err) {
    if (err instanceof DisciplinaryForbiddenError) {
      accessForbidden = true;
    } else {
      throw err;
    }
  }

  // Load active departments for the filter bar.
  const activeTerm = await getActiveTerm();

  const departments = activeTerm
    ? await prisma.department.findMany({
        where: {
          memberships: { some: { termId: activeTerm.id, status: "ACTIVE" } },
        },
        orderBy: { code: "asc" },
      })
    : [];

  const rows = listResult?.rows ?? [];
  const total = listResult?.total ?? 0;
  const canManageAll = listResult?.canManageAll ?? false;
  const pageCount = Math.max(1, Math.ceil(total / 25));

  // Label any report a visible strike is linked to. One query, no N+1.
  const linkedReportIds = [...new Set(rows.map((r) => r.action.reportId).filter(Boolean))] as string[];
  const linkedReports = linkedReportIds.length
    ? await prisma.incidentReport.findMany({
        where: { id: { in: linkedReportIds } },
        select: { id: true, number: true },
      })
    : [];
  const reportLabelById = new Map(linkedReports.map((r) => [r.id, `Incident report #${r.number}`]));

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (qSearch) params.set("q", qSearch);
    if (departmentId) params.set("departmentId", departmentId);
    if (categoryFilter) params.set("category", categoryFilter);
    params.set("page", String(targetPage));
    return `/incidents/strikes?${params.toString()}`;
  }

  // Compute report options once for all strike rows.
  const reportComboOptions = reportOptions.map((r) => ({ value: r.id, label: r.label }));

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function issueActionForm(formData: FormData) {
    "use server";
    const actor = await requirePermission("incidents.view_strikes");
    if (!(await can(actor.personId, "incidents.manage"))) {
      redirect("/incidents/strikes?error=forbidden");
    }

    const occurredAtStr = (formData.get("occurredAt") as string | null) ?? "";
    const category = (formData.get("category") as string | null) ?? "";
    const description = ((formData.get("description") as string | null) ?? "").trim();
    const followUpActions = (formData.get("followUpActions") as string | null) || null;
    const policyReference = (formData.get("policyReference") as string | null) || null;
    const notes = (formData.get("notes") as string | null) || null;
    const confidential = formData.get("confidential") === "on";
    const patientInvolved = formData.get("patientInvolved") === "on";
    const reportId = (formData.get("reportId") as string | null) || null;
    const notifyPeople = formData.get("notifyPeople") === "on";

    const personId = (formData.get("personId") as string | null) || null;
    if (!personId) {
      redirect("/incidents/strikes?error=person-not-found");
    }

    const occurredAt = occurredAtStr ? new Date(occurredAtStr) : null;
    if (!occurredAt || isNaN(occurredAt.getTime())) {
      redirect("/incidents/strikes?error=validation");
    }

    let action: DisciplinaryAction;
    try {
      action = await issueAction(actor.personId, {
        personId,
        occurredAt: occurredAt!,
        category,
        description,
        followUpActions,
        policyReference,
        notes,
        confidential,
        patientInvolved,
        reportId,
      });
    } catch (err) {
      if (err instanceof DisciplinaryForbiddenError) {
        redirect("/incidents/strikes?error=forbidden");
      }
      if (err instanceof DisciplinaryNotFoundError) {
        redirect("/incidents/strikes?error=person-not-found");
      }
      if (err instanceof DisciplinaryValidationError) {
        const msg = err.message.toLowerCase();
        if (msg.includes("category")) redirect("/incidents/strikes?error=bad-category");
        if (msg.includes("description")) redirect("/incidents/strikes?error=blank-description");
        if (msg.includes("future")) redirect("/incidents/strikes?error=future-date");
        redirect(
          `/incidents/strikes?error=validation&message=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }

    // After the write commits, never inside it: a rollback must not mail anyone.
    if (notifyPeople) {
      await notifyStrikeIssued({ action, actorPersonId: actor.personId });
    }

    revalidatePath("/incidents/strikes");
    redirect("/incidents/strikes");
  }

  // Consumed as a prop by StrikeRow's link/unlink control below.
  async function linkReportForm(formData: FormData) {
    "use server";
    const actor = await requirePermission("incidents.manage");
    const actionId = (formData.get("actionId") as string | null) ?? "";
    // An empty value means unlink.
    const reportId = (formData.get("reportId") as string | null) || null;
    try {
      await linkActionToReport(actor.personId, actionId, reportId);
    } catch (err) {
      if (err instanceof DisciplinaryForbiddenError) {
        redirect("/incidents/strikes?error=forbidden");
      }
      if (err instanceof DisciplinaryNotFoundError) {
        redirect("/incidents/strikes?error=not-found");
      }
      if (err instanceof DisciplinaryValidationError) {
        redirect(
          `/incidents/strikes?error=validation&message=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    revalidatePath("/incidents/strikes");
    redirect("/incidents/strikes");
  }

  async function deleteActionForm(formData: FormData) {
    "use server";
    const actor = await requirePermission("incidents.manage");
    const actionId = (formData.get("actionId") as string | null) ?? "";
    try {
      await deleteAction(actor.personId, actionId);
    } catch (err) {
      if (err instanceof DisciplinaryForbiddenError) {
        redirect("/incidents/strikes?error=forbidden");
      }
      if (err instanceof DisciplinaryNotFoundError) {
        redirect("/incidents/strikes?error=not-found");
      }
      throw err;
    }
    revalidatePath("/incidents/strikes");
    redirect("/incidents/strikes");
  }

  return (
    <div>
      <PageHeader
        title="Strikes"
        description="Issued disciplinary strikes. Directors see their departments; reviewers see all and can issue or delete."
      />

      {errorMessage && (
        <Alert tone="error" className="mt-4">
          {errorMessage}
        </Alert>
      )}

      {/* Issue form -- only reviewers with incidents.manage may record an action
          here. Directors hold incidents.view_strikes but not incidents.manage, so
          issueActionForm would reject their submit; they request strikes through
          an incident report instead. Gate the form so they see the read-only
          ledger without a dead-end form. */}
      {canManageAll && (
      <section className="mt-8">
        <h2 className="mb-3 text-base font-semibold">Record Disciplinary Action</h2>
        <form action={issueActionForm}>
          <Card>
            <div className="flex flex-wrap items-end gap-3">

              {/* Person picker: searchable combobox for central, select for directors */}
              {issuable.all ? (
                <div className="w-72">
                  <Field label="Person" required>
                    <Combobox
                      name="personId"
                      ariaLabel="Person"
                      placeholder="Search by name..."
                      required
                      options={searchablePeople.map((p) => ({
                        value: p.id,
                        label: p.hint ? `${p.name} (${p.hint})` : p.name,
                      }))}
                    />
                  </Field>
                </div>
              ) : (
                <div className="w-64">
                  <Field label="Person" required>
                    <Select name="personId" required>
                      <option value="">Select person...</option>
                      {issuable.people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name ?? p.id}
                          {p.departmentNames.length > 0 ? ` (${p.departmentNames.join(", ")})` : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}

              {/* Date */}
              <div className="w-44">
                <Field label="Date of incident" required>
                  <Input type="date" name="occurredAt" required />
                </Field>
              </div>

              {/* Category */}
              <div className="w-52">
                <Field label="Category" required>
                  <Select name="category" required>
                    <option value="">Select category...</option>
                    {DISCIPLINARY_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              {/* Optional link to the incident report this strike relates to. */}
              <div className="w-72">
                <Field label="Related incident report">
                  <Combobox
                    name="reportId"
                    ariaLabel="Related incident report"
                    placeholder="Search reports..."
                    emptyLabel="No matching reports"
                    options={reportOptions.map((r) => ({ value: r.id, label: r.label }))}
                  />
                </Field>
              </div>

              {/* Description */}
              <div className="w-full">
                <Field label="Description" required>
                  <Textarea
                    name="description"
                    rows={3}
                    required
                    placeholder="Describe the incident..."
                  />
                </Field>
              </div>

              {/* Follow-up actions */}
              <div className="w-full">
                <Field label="Follow-up actions">
                  <Textarea
                    name="followUpActions"
                    rows={2}
                    placeholder="Optional follow-up actions..."
                  />
                </Field>
              </div>

              {/* Policy reference */}
              <div className="w-56">
                <Field label="Policy reference">
                  <Input name="policyReference" placeholder="Optional" />
                </Field>
              </div>

              {/* Notes */}
              <div className="flex-1 min-w-48">
                <Field label="Notes">
                  <Textarea
                    name="notes"
                    rows={2}
                    placeholder="Optional internal notes..."
                  />
                </Field>
              </div>

              {/* Checkboxes */}
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-foreground-soft cursor-pointer">
                  <Checkbox name="notifyPeople" defaultChecked />
                  Notify by email
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground-soft cursor-pointer">
                  <Checkbox name="confidential" />
                  Confidential
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground-soft cursor-pointer">
                  <Checkbox name="patientInvolved" />
                  Patient involved
                </label>
              </div>
            </div>

            <FormActions>
              <SubmitButton variant="primary" size="sm" pendingLabel="Recording…">
                Record action
              </SubmitButton>
            </FormActions>
          </Card>
        </form>
      </section>
      )}

      {/* Filter bar */}
      <NavForm
        action="/incidents/strikes"
        className="mt-10 flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-44">
          <Field label="Search">
            <Input
              type="search"
              name="q"
              defaultValue={qSearch ?? ""}
              placeholder="Person name..."
            />
          </Field>
        </div>

        <div className="w-52">
          <Field label="Department">
            <Select name="departmentId" defaultValue={departmentId ?? ""}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} - {d.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="w-52">
          <Field label="Category">
            <Select name="category" defaultValue={categoryFilter ?? ""}>
              <option value="">All categories</option>
              {DISCIPLINARY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Button type="submit" variant="primary" size="sm">
          Filter
        </Button>

        {(qSearch || departmentId || categoryFilter) && (
          <Link
            href="/incidents/strikes"
            className={buttonClasses("outline", "sm")}
          >
            Clear
          </Link>
        )}
      </NavForm>

      {/* Records table */}
      <section className="mt-6">
        {accessForbidden ? (
          <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <p>You do not have access to disciplinary records.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <p>No disciplinary actions found.</p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {total} action{total === 1 ? "" : "s"}
            </p>

            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Person</TH>
                  <TH>Category</TH>
                  <TH>Description</TH>
                  <TH>Issued by</TH>
                  <TH>Flags</TH>
                  <TH>Strikes</TH>
                  {canManageAll && <TH><span className="sr-only">Actions</span></TH>}
                </TR>
              </THead>
              <tbody>
                {rows.map(({ action, personName, issuedByName, strikes }) => (
                  <StrikeRow
                    key={action.id}
                    action={{
                      id: action.id,
                      occurredLabel: formatDateOnly(action.occurredAt, displayZone, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      }),
                      category: action.category,
                      description: action.description,
                      followUpActions: action.followUpActions,
                      policyReference: action.policyReference,
                      notes: action.notes,
                      confidential: action.confidential,
                      patientInvolved: action.patientInvolved,
                      reportId: action.reportId,
                      reportLabel: action.reportId
                        ? (reportLabelById.get(action.reportId) ?? null)
                        : null,
                    }}
                    personName={personName}
                    issuedByName={issuedByName}
                    strikes={strikes}
                    canManageAll={canManageAll}
                    reportOptions={reportComboOptions}
                    deleteAction={deleteActionForm}
                    linkReport={linkReportForm}
                  />
                ))}
              </tbody>
            </Table>

            <div className="mt-4">
              <Pagination page={page} pageCount={pageCount} hrefFor={buildHref} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
