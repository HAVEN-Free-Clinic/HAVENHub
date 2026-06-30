/**
 * PersonMembershipsPanel: manage a person's department assignments for the
 * ACTIVE term (add, change role, remove) plus a read-only history of all terms.
 *
 * Editing controls render only when canManage (admin.manage_roster); the server
 * actions re-check the permission. Mirrors the term RosterPanel pattern: server
 * component, GET-free forms, ConfirmButton for destructive actions.
 */

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  addMembership,
  removeMembership,
  changeMembershipKind,
  membershipHasDirectorShifts,
  MembershipForeignKeyError,
  MembershipNotFoundError,
  DirectorHasShiftAssignmentsError,
} from "@/modules/admin/services/roster";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

type Props = {
  personId: string;
  canManage: boolean;
  baseHref: string;
  rosterError?: string;
};

export async function PersonMembershipsPanel({
  personId,
  canManage,
  baseHref,
  rosterError,
}: Props): Promise<ReactNode> {
  const [activeTerm, memberships, departments] = await Promise.all([
    getActiveTerm(),
    prisma.termMembership.findMany({
      where: { personId },
      include: { term: true, department: true },
      orderBy: [{ term: { startDate: "desc" } }, { department: { code: "asc" } }],
    }),
    prisma.department.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }),
  ]);

  const activeMembers = activeTerm
    ? memberships.filter((m) => m.termId === activeTerm.id && m.status === "ACTIVE")
    : [];

  async function addAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roster");
    const term = await getActiveTerm();
    if (!term) redirect(`${baseHref}?rosterError=${encodeURIComponent("No active term.")}`);
    const departmentId = formData.get("departmentId") as string | null;
    const kindRaw = formData.get("kind");
    const kind = kindRaw === "DIRECTOR" || kindRaw === "VOLUNTEER" ? kindRaw : null;
    if (!departmentId || !kind) {
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Department and role are required.")}`);
    }
    try {
      await addMembership(actor.personId, { personId, termId: term!.id, departmentId: departmentId!, kind });
    } catch (err) {
      if (err instanceof MembershipForeignKeyError) {
        redirect(`${baseHref}?rosterError=${encodeURIComponent(`Invalid reference: ${err.field}`)}`);
      }
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Failed to add assignment.")}`);
    }
    redirect(`${baseHref}?saved=1`);
  }

  async function changeKindAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roster");
    const membershipId = formData.get("membershipId") as string | null;
    const toKindRaw = formData.get("toKind");
    const toKind = toKindRaw === "DIRECTOR" || toKindRaw === "VOLUNTEER" ? toKindRaw : null;
    if (!membershipId || !toKind) {
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Missing role change input.")}`);
    }
    try {
      await changeMembershipKind(actor.personId, { membershipId: membershipId!, toKind });
    } catch (err) {
      if (err instanceof DirectorHasShiftAssignmentsError) {
        redirect(
          `${baseHref}?rosterError=${encodeURIComponent("This member has director shift assignments this term. Remove or reassign those shifts before changing their role.")}`
        );
      }
      if (err instanceof MembershipNotFoundError) {
        redirect(`${baseHref}?rosterError=${encodeURIComponent("Membership no longer exists; the page may be stale.")}`);
      }
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Failed to change role.")}`);
    }
    redirect(`${baseHref}?saved=1`);
  }

  async function removeAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roster");
    const membershipId = formData.get("membershipId") as string | null;
    if (!membershipId) redirect(`${baseHref}?rosterError=${encodeURIComponent("Missing membership ID.")}`);
    if (await membershipHasDirectorShifts(membershipId!)) {
      redirect(
        `${baseHref}?rosterError=${encodeURIComponent("This member has director shift assignments this term. Remove or reassign those shifts before removing their director role.")}`
      );
    }
    try {
      await removeMembership(actor.personId, membershipId!);
    } catch (err) {
      if (err instanceof MembershipNotFoundError) {
        redirect(`${baseHref}?rosterError=${encodeURIComponent("Membership no longer exists; the page may be stale.")}`);
      }
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Failed to remove assignment.")}`);
    }
    redirect(`${baseHref}?saved=1`);
  }

  return (
    <section className="space-y-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Memberships</h2>
      {rosterError && <Alert tone="error">{rosterError}</Alert>}

      {activeTerm ? (
        <Card className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground-soft">Active term ({activeTerm.code})</h3>
          {activeMembers.length === 0 ? (
            <p className="text-sm text-subtle-foreground">No active-term assignments.</p>
          ) : (
            <div className="space-y-2">
              {activeMembers.map((m) => (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                >
                  <span className="text-sm font-medium text-foreground">{m.department.code}</span>
                  {m.kind === "DIRECTOR" ? <Badge tone="brand">Director</Badge> : <Badge tone="default">Volunteer</Badge>}
                  {canManage && (
                    <div className="ml-auto flex items-center gap-2">
                      <form action={changeKindAction} className="flex items-center gap-1">
                        <input type="hidden" name="membershipId" value={m.id} />
                        <input type="hidden" name="toKind" value={m.kind === "DIRECTOR" ? "VOLUNTEER" : "DIRECTOR"} />
                        <ConfirmButton
                          label={m.kind === "DIRECTOR" ? "Make volunteer" : "Make director"}
                          confirmLabel="Change this member's role? Confirm?"
                        />
                      </form>
                      <form action={removeAction}>
                        <input type="hidden" name="membershipId" value={m.id} />
                        <ConfirmButton label="Remove" confirmLabel="Remove assignment?" />
                      </form>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {canManage && (
            <form action={addAction} className="flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
              <Field label="Department">
                <Select name="departmentId" className="w-56">
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} -- {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Role">
                <Select name="kind" className="w-36">
                  <option value="VOLUNTEER">Volunteer</option>
                  <option value="DIRECTOR">Director</option>
                </Select>
              </Field>
              <Button type="submit" variant="primary" size="sm">
                Add assignment
              </Button>
            </form>
          )}
        </Card>
      ) : (
        <p className="text-sm text-subtle-foreground">No active term.</p>
      )}

      {memberships.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground-soft">History</h3>
          <Table>
            <THead>
              <TR>
                <TH>Term</TH>
                <TH>Department</TH>
                <TH>Kind</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <tbody>
              {memberships.map((m) => (
                <TR key={m.id}>
                  <TD>{m.term.code}</TD>
                  <TD>{m.department.code}</TD>
                  <TD>{m.kind === "DIRECTOR" ? <Badge tone="brand">Director</Badge> : <Badge tone="default">Volunteer</Badge>}</TD>
                  <TD>{m.status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="default">Removed</Badge>}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  );
}
