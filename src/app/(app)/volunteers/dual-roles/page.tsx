import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  DUAL_ROLE_PERMISSION,
  DualRoleError,
  acceptDualRole,
  declineDualRole,
  listDualRoleQueue,
  type DualRoleQueueRow,
} from "@/platform/dual-roles";
import { formatSpanishScore, spanishScoreTone } from "@/platform/languages/catalog";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Input } from "@/platform/ui/input";

/**
 * Dual-role queue: volunteers accepted into one department who offered to also
 * serve this one.
 *
 * The offer comes from the application's dual-option checkbox and is recorded at
 * promotion (see platform/dual-roles). It is an offer, never an enrollment:
 * both departments that ask the question gate on something the form cannot
 * check -- VADM on a licence to administer vaccines, INTP on the language
 * assessment its help text promises -- so a person reaches the roster only when
 * a director here says so.
 *
 * Scoped by department, not by seniority. Every director holds the permission;
 * `listDualRoleQueue` resolves it through permissionDepartmentIds, so each one
 * sees offers made to the departments they actually direct and no others. A
 * director of a department nobody can offer to sees an empty queue.
 *
 * No data access or mutation logic lives in this file: it is all in
 * platform/dual-roles, where it is reachable from a test.
 */

const BASE_PATH = "/volunteers/dual-roles";

type PageProps = {
  searchParams: Promise<{ show?: string; error?: string; ok?: string }>;
};

function hrefWith(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `${BASE_PATH}?${s}` : BASE_PATH;
}

function messageFor(err: unknown, fallback: string): string {
  return err instanceof DualRoleError ? err.message : fallback;
}

export default async function DualRolesPage({ searchParams }: PageProps) {
  const session = await requirePermission(DUAL_ROLE_PERMISSION);
  const sp = await searchParams;
  const includeDecided = sp.show === "all";
  const rows = await listDualRoleQueue(session.personId, { includeDecided });
  const pending = rows.filter((r) => r.status === "PENDING");
  const decided = rows.filter((r) => r.status !== "PENDING");

  async function acceptAction(formData: FormData) {
    "use server";
    const actor = await requirePermission(DUAL_ROLE_PERMISSION);
    const back = { show: String(formData.get("returnShow") ?? "") || undefined };
    const id = String(formData.get("id") ?? "");
    try {
      await acceptDualRole(actor.personId, id, String(formData.get("notes") ?? ""));
    } catch (err) {
      redirect(hrefWith({ ...back, error: messageFor(err, "Could not add them to the roster.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(hrefWith({ ...back, ok: "Added to the roster." }));
  }

  async function declineAction(formData: FormData) {
    "use server";
    const actor = await requirePermission(DUAL_ROLE_PERMISSION);
    const back = { show: String(formData.get("returnShow") ?? "") || undefined };
    const id = String(formData.get("id") ?? "");
    try {
      await declineDualRole(actor.personId, id, String(formData.get("notes") ?? ""));
    } catch (err) {
      redirect(hrefWith({ ...back, error: messageFor(err, "Could not decline that offer.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(hrefWith({ ...back, ok: "Offer declined." }));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dual roles"
        description="Volunteers serving another department who offered to also help yours. Accepting puts them on your roster for this term; it does not change the department they were accepted into."
      />

      {/* No inline Alert: FlashReader claims this param, toasts it, and strips it
          from the URL, so an inline branch reported it twice and then lost its
          value on the router.replace. Error toasts do not auto-dismiss. */}
      {sp.ok && <Alert tone="success">{sp.ok}</Alert>}

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Awaiting your decision</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Check that they meet your department&rsquo;s requirements before adding them. Nobody
              here has been vetted for your department by anyone else.
            </p>
          </div>
          <Link
            href={hrefWith({ show: includeDecided ? undefined : "all" })}
            className="shrink-0 text-xs text-muted-foreground underline hover:text-foreground"
          >
            {includeDecided ? "Hide decided" : "Show decided"}
          </Link>
        </div>

        {pending.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            No dual-role offers are waiting.
          </Card>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Currently serving</TH>
                <TH>Offered to</TH>
                <TH>Languages</TH>
                <TH>Decision</TH>
              </TR>
            </THead>
            <tbody>
              {pending.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">
                    <Link href={r.applicationHref} className="underline hover:text-foreground">
                      {r.personName}
                    </Link>
                  </TD>
                  <TD className="text-muted-foreground">
                    {r.primaryDepartments.length > 0 ? (
                      r.primaryDepartments.join(", ")
                    ) : (
                      <span className="text-subtle-foreground">Not on a roster yet</span>
                    )}
                  </TD>
                  <TD>
                    <Badge>{r.departmentCode}</Badge>
                  </TD>
                  <TD>
                    <LanguageCell row={r} />
                  </TD>
                  <TD>
                    <DecideForm
                      row={r}
                      show={includeDecided ? "all" : ""}
                      acceptAction={acceptAction}
                      declineAction={declineAction}
                    />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {includeDecided && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Already decided</h2>
          {decided.length === 0 ? (
            <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
              Nothing decided yet this term.
            </Card>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Offered to</TH>
                  <TH>Outcome</TH>
                  <TH>Decided by</TH>
                  <TH>Note</TH>
                </TR>
              </THead>
              <tbody>
                {decided.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.personName}</TD>
                    <TD>
                      <Badge>{r.departmentCode}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={r.status === "ACCEPTED" ? "success" : "default"}>
                        {r.status === "ACCEPTED" ? "Added" : "Declined"}
                      </Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      {r.decidedByName ?? <span className="text-subtle-foreground">-</span>}
                    </TD>
                    <TD className="text-muted-foreground">
                      {r.notes ?? <span className="text-subtle-foreground">-</span>}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Verified languages, and the 1-5 Spanish score where there is one.
 *
 * Context, never a gate: an unassessed offer is still a real offer, and this
 * tells the director whether the next step is "add them" or "send them to the
 * language queue first". Rendered for every row rather than INTP-only, because
 * a language is worth knowing about anywhere a volunteer meets patients.
 */
function LanguageCell({ row }: { row: DualRoleQueueRow }) {
  if (row.languages.length === 0) {
    return <span className="text-xs text-subtle-foreground">None verified</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.languages.map((l) => (
        <Badge key={l}>{l}</Badge>
      ))}
      {row.spanishScore !== null && (
        <Badge tone={spanishScoreTone(row.spanishScore)}>
          {formatSpanishScore(row.spanishScore, null)}
        </Badge>
      )}
    </div>
  );
}

function DecideForm({
  row,
  show,
  acceptAction,
  declineAction,
}: {
  row: DualRoleQueueRow;
  show: string;
  acceptAction: (formData: FormData) => Promise<void>;
  declineAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* One note field, submitted by whichever button is pressed. Two forms
          would need two copies of it and could disagree about what was typed. */}
      <form action={acceptAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={row.id} />
        <input type="hidden" name="returnShow" value={show} />
        <Input
          name="notes"
          placeholder="Note (optional)"
          className="w-44"
          aria-label={`Note about ${row.personName}`}
        />
        <SubmitButton size="sm">Add to roster</SubmitButton>
        <SubmitButton size="sm" variant="outline" formAction={declineAction}>
          Decline
        </SubmitButton>
      </form>
    </div>
  );
}
