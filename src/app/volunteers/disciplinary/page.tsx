/**
 * Disciplinary actions log page for Volunteer Management.
 *
 * Access: requirePermission("volunteers.view") -- same gate as offboarding.
 * The volunteers layout already gates on volunteers.view; this call is
 * defense-in-depth and supplies the actor's personId.
 *
 * Visibility is enforced by the service (listActions / issuablePeople).
 * A DisciplinaryForbiddenError from listActions is caught here and renders
 * a friendly empty state instead of a hard error.
 *
 * Server actions:
 *   issueActionForm  -- re-checks volunteers.view (service enforces scope).
 *   deleteActionForm -- re-checks volunteers.issue_disciplinary.
 */

import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import {
  issueAction,
  deleteAction,
  listActions,
  issuablePeople,
  DISCIPLINARY_CATEGORIES,
  DisciplinaryForbiddenError,
  DisciplinaryNotFoundError,
  DisciplinaryValidationError,
} from "@/modules/volunteers/services/disciplinary";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for that action.",
  "not-found": "The disciplinary action could not be found.",
  "bad-category": "Invalid category. Please select a valid category.",
  "blank-description": "Description must not be blank.",
  "future-date": "Occurred date must not be in the future.",
  "person-not-found": "Person not found. Check the NetID or email and try again.",
  "validation": "Please check your input and try again.",
};

// ---------------------------------------------------------------------------
// Date helpers (UTC)
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

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
  }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DisciplinaryPage({ searchParams }: PageProps) {
  const viewer = await requirePermission("volunteers.view");
  const sp = await searchParams;

  const qSearch = sp.q?.trim() || undefined;
  const departmentId = sp.departmentId || undefined;
  const categoryFilter = sp.category || undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const errorCode = sp.error ?? null;
  const errorMessage = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? decodeURIComponent(errorCode))
    : null;

  // Load issuable people for the issue form.
  const issuable = await issuablePeople(viewer.personId);

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
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

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

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (qSearch) params.set("q", qSearch);
    if (departmentId) params.set("departmentId", departmentId);
    if (categoryFilter) params.set("category", categoryFilter);
    params.set("page", String(targetPage));
    return `/volunteers/disciplinary?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function issueActionForm(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.view");

    const occurredAtStr = (formData.get("occurredAt") as string | null) ?? "";
    const category = (formData.get("category") as string | null) ?? "";
    const description = ((formData.get("description") as string | null) ?? "").trim();
    const followUpActions = (formData.get("followUpActions") as string | null) || null;
    const policyReference = (formData.get("policyReference") as string | null) || null;
    const notes = (formData.get("notes") as string | null) || null;
    const confidential = formData.get("confidential") === "on";
    const patientInvolved = formData.get("patientInvolved") === "on";

    // Resolve person -- either personId (select) or personKey (free input).
    let personId = (formData.get("personId") as string | null) || null;
    if (!personId) {
      const personKey = (formData.get("personKey") as string | null)?.trim() ?? "";
      if (!personKey) {
        redirect("/volunteers/disciplinary?error=person-not-found");
      }
      const person = await prisma.person.findFirst({
        where: {
          OR: [
            { netId: personKey },
            { contactEmail: { equals: personKey, mode: "insensitive" } },
          ],
        },
        select: { id: true },
      });
      if (!person) {
        redirect("/volunteers/disciplinary?error=person-not-found");
      }
      personId = person.id;
    }

    const occurredAt = occurredAtStr ? new Date(occurredAtStr) : null;
    if (!occurredAt || isNaN(occurredAt.getTime())) {
      redirect("/volunteers/disciplinary?error=validation");
    }

    try {
      await issueAction(actor.personId, {
        personId: personId!,
        occurredAt: occurredAt!,
        category,
        description,
        followUpActions,
        policyReference,
        notes,
        confidential,
        patientInvolved,
      });
    } catch (err) {
      if (err instanceof DisciplinaryForbiddenError) {
        redirect("/volunteers/disciplinary?error=forbidden");
      }
      if (err instanceof DisciplinaryNotFoundError) {
        redirect("/volunteers/disciplinary?error=person-not-found");
      }
      if (err instanceof DisciplinaryValidationError) {
        const msg = err.message.toLowerCase();
        if (msg.includes("category")) redirect("/volunteers/disciplinary?error=bad-category");
        if (msg.includes("description")) redirect("/volunteers/disciplinary?error=blank-description");
        if (msg.includes("future")) redirect("/volunteers/disciplinary?error=future-date");
        redirect(`/volunteers/disciplinary?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/disciplinary");
    redirect("/volunteers/disciplinary");
  }

  async function deleteActionForm(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.issue_disciplinary");
    const actionId = (formData.get("actionId") as string | null) ?? "";
    try {
      await deleteAction(actor.personId, actionId);
    } catch (err) {
      if (err instanceof DisciplinaryForbiddenError) {
        redirect("/volunteers/disciplinary?error=forbidden");
      }
      if (err instanceof DisciplinaryNotFoundError) {
        redirect("/volunteers/disciplinary?error=not-found");
      }
      throw err;
    }
    revalidatePath("/volunteers/disciplinary");
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <PageHeader
        title="Disciplinary Actions"
        description="Record and review formal disciplinary actions"
      />

      {errorMessage && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {errorMessage}
        </p>
      )}

      {/* Issue form */}
      <section className="mt-8">
        <h2 className="mb-3 text-base font-semibold">Record Disciplinary Action</h2>
        <form action={issueActionForm} className="flex flex-wrap items-end gap-3">

          {/* Person picker: free input for central, select for directors */}
          {issuable.all ? (
            <div className="w-56">
              <label className="block text-xs font-medium text-slate-500 mb-1">
                NetID or email
              </label>
              <Input
                name="personKey"
                placeholder="netid or email@yale.edu"
                required
              />
            </div>
          ) : (
            <div className="w-64">
              <label className="block text-xs font-medium text-slate-500 mb-1">
                Person
              </label>
              <Select name="personId" required>
                <option value="">Select person...</option>
                {issuable.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? p.id}
                    {p.departmentNames.length > 0 ? ` (${p.departmentNames.join(", ")})` : ""}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* Date */}
          <div className="w-44">
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Date of incident
            </label>
            <Input type="date" name="occurredAt" required />
          </div>

          {/* Category */}
          <div className="w-52">
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Category
            </label>
            <Select name="category" required>
              <option value="">Select category...</option>
              {DISCIPLINARY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>

          {/* Description */}
          <div className="w-full">
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Description <span className="text-critical">*</span>
            </label>
            <textarea
              name="description"
              rows={3}
              required
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="Describe the incident..."
            />
          </div>

          {/* Follow-up actions */}
          <div className="w-full">
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Follow-up actions
            </label>
            <textarea
              name="followUpActions"
              rows={2}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="Optional follow-up actions..."
            />
          </div>

          {/* Policy reference */}
          <div className="w-56">
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Policy reference
            </label>
            <Input name="policyReference" placeholder="Optional" />
          </div>

          {/* Notes */}
          <div className="flex-1 min-w-48">
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Notes
            </label>
            <textarea
              name="notes"
              rows={2}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="Optional internal notes..."
            />
          </div>

          {/* Checkboxes */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input type="checkbox" name="confidential" className="rounded" />
              Confidential
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input type="checkbox" name="patientInvolved" className="rounded" />
              Patient involved
            </label>
          </div>

          <Button type="submit" variant="outline" size="sm">
            Record action
          </Button>
        </form>
      </section>

      {/* Filter bar */}
      <form
        method="GET"
        action="/volunteers/disciplinary"
        className="mt-10 flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-44">
          <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
          <Input
            type="search"
            name="q"
            defaultValue={qSearch ?? ""}
            placeholder="Person name..."
          />
        </div>

        <div className="w-52">
          <label className="block text-xs font-medium text-slate-500 mb-1">Department</label>
          <Select name="departmentId" defaultValue={departmentId ?? ""}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} - {d.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-52">
          <label className="block text-xs font-medium text-slate-500 mb-1">Category</label>
          <Select name="category" defaultValue={categoryFilter ?? ""}>
            <option value="">All categories</option>
            {DISCIPLINARY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>

        <button
          type="submit"
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Filter
        </button>

        {(qSearch || departmentId || categoryFilter) && (
          <Link
            href="/volunteers/disciplinary"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Clear
          </Link>
        )}
      </form>

      {/* Records table */}
      <section className="mt-6">
        {accessForbidden ? (
          <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-slate-500">
            <p>You do not have access to disciplinary records.</p>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">No disciplinary actions found.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-500">
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
                  {canManageAll && <TH></TH>}
                </TR>
              </THead>
              <tbody>
                {rows.map(({ action, personName, issuedByName, strikes }) => (
                  <TR key={action.id}>
                    <TD className="tabular-nums text-sm text-slate-600 whitespace-nowrap">
                      {fmtDate(action.occurredAt)}
                    </TD>
                    <TD className="font-medium">{personName ?? "-"}</TD>
                    <TD>
                      <Badge tone="default">{action.category}</Badge>
                    </TD>
                    <TD className="max-w-xs text-sm text-slate-700">
                      <span title={action.description} className="line-clamp-2">
                        {action.description}
                      </span>
                    </TD>
                    <TD className="text-sm text-slate-600">{issuedByName ?? "-"}</TD>
                    <TD>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {action.confidential && (
                          <Badge tone="warning">Confidential</Badge>
                        )}
                        {action.patientInvolved && (
                          <Badge tone="critical">Patient</Badge>
                        )}
                      </div>
                    </TD>
                    <TD className="tabular-nums text-sm font-medium text-slate-700">
                      {strikes}
                    </TD>
                    {canManageAll && (
                      <TD>
                        <form action={deleteActionForm}>
                          <input type="hidden" name="actionId" value={action.id} />
                          <ConfirmButton
                            label="Delete"
                            confirmLabel="Delete this disciplinary action? This cannot be undone."
                          />
                        </form>
                      </TD>
                    )}
                  </TR>
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
