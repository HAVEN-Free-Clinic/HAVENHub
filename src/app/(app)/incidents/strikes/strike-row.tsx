"use client";

import { useId, useState } from "react";
import { TR, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Combobox } from "@/platform/ui/combobox";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

/**
 * One row of the strikes ledger, with an expandable detail row.
 *
 * The collapsed row is the ledger's seven columns; the Description cell doubles
 * as the expand toggle, since a clamped description is the reason ops asked for
 * this. Expanding reveals the full description plus the fields the table has no
 * room for (follow-up actions, policy reference, internal notes) and, for
 * central reviewers, the control that links this strike to an incident report.
 *
 * Every prop is plain serialized data: dates arrive preformatted from the server
 * so no Date instance crosses the RSC boundary. The two server actions pass
 * through as props, which RSC supports.
 */
export type StrikeRowProps = {
  action: {
    id: string;
    occurredLabel: string;
    category: string;
    description: string;
    followUpActions: string | null;
    policyReference: string | null;
    notes: string | null;
    confidential: boolean;
    patientInvolved: boolean;
    reportId: string | null;
    reportLabel: string | null;
  };
  personName: string;
  issuedByName: string;
  strikes: number;
  canManageAll: boolean;
  /** Report options for the link control. Empty for non-central viewers. */
  reportOptions: Array<{ value: string; label: string }>;
  deleteAction: (formData: FormData) => Promise<void>;
  linkReport: (formData: FormData) => Promise<void>;
};

export function StrikeRow({
  action,
  personName,
  issuedByName,
  strikes,
  canManageAll,
  reportOptions,
  deleteAction,
  linkReport,
}: StrikeRowProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  // Seven data columns, plus the actions column for central reviewers.
  const columnCount = canManageAll ? 8 : 7;

  return (
    <>
      <TR>
        <TD className="tabular-nums text-sm text-foreground-soft whitespace-nowrap">
          {action.occurredLabel}
        </TD>
        <TD className="font-medium">{personName}</TD>
        <TD>
          <Badge tone="default">{action.category}</Badge>
        </TD>
        <TD className="max-w-xs text-sm text-foreground-soft">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailId}
            // eslint-disable-next-line no-restricted-syntax -- full-width expand toggle wrapping clamped description text, not a Button primitive shape
            className="w-full text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded-lg"
          >
            <span className={open ? undefined : "line-clamp-2"}>{action.description}</span>
            <span className="mt-0.5 block text-xs text-subtle-foreground">
              {open ? "Hide details" : "Show details"}
            </span>
          </button>
        </TD>
        <TD className="text-sm text-foreground-soft">{issuedByName}</TD>
        <TD>
          <div className="flex items-center gap-1.5 flex-wrap">
            {action.confidential && <Badge tone="warning">Confidential</Badge>}
            {action.patientInvolved && <Badge tone="critical">Patient</Badge>}
          </div>
        </TD>
        <TD className="tabular-nums text-sm font-medium text-foreground-soft">{strikes}</TD>
        {canManageAll && (
          <TD>
            <form action={deleteAction}>
              <input type="hidden" name="actionId" value={action.id} />
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete this disciplinary action? This cannot be undone."
              />
            </form>
          </TD>
        )}
      </TR>

      <TR id={detailId} hidden={!open}>
        <TD colSpan={columnCount} className="bg-muted/40">
          <dl className="grid gap-4 py-2 text-sm sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="font-medium text-foreground">Description</dt>
              <dd className="mt-1 whitespace-pre-wrap text-foreground-soft">
                {action.description}
              </dd>
            </div>

            {action.followUpActions && (
              <div>
                <dt className="font-medium text-foreground">Follow-up actions</dt>
                <dd className="mt-1 whitespace-pre-wrap text-foreground-soft">
                  {action.followUpActions}
                </dd>
              </div>
            )}

            {action.policyReference && (
              <div>
                <dt className="font-medium text-foreground">Policy reference</dt>
                <dd className="mt-1 text-foreground-soft">{action.policyReference}</dd>
              </div>
            )}

            {action.notes && (
              <div className="sm:col-span-2">
                <dt className="font-medium text-foreground">Internal notes</dt>
                <dd className="mt-1 whitespace-pre-wrap text-foreground-soft">{action.notes}</dd>
              </div>
            )}

            <div className="sm:col-span-2">
              <dt className="font-medium text-foreground">Incident report</dt>
              <dd className="mt-1 text-foreground-soft">
                {action.reportLabel ?? "Not linked to a report."}
              </dd>

              {canManageAll && (
                <dd className="mt-2">
                  {action.reportId ? (
                    <form action={linkReport}>
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="reportId" value="" />
                      <Button type="submit" variant="outline" size="sm">
                        Unlink report
                      </Button>
                    </form>
                  ) : (
                    <form action={linkReport} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="actionId" value={action.id} />
                      <div className="w-72">
                        <Combobox
                          name="reportId"
                          ariaLabel={`Link ${personName}'s strike to an incident report`}
                          placeholder="Search reports..."
                          emptyLabel="No matching reports"
                          options={reportOptions}
                        />
                      </div>
                      <Button type="submit" variant="outline" size="sm">
                        Link report
                      </Button>
                    </form>
                  )}
                </dd>
              )}
            </div>
          </dl>
        </TD>
      </TR>
    </>
  );
}
