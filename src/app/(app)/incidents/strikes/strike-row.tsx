"use client";

import { useId, useState } from "react";
import { TR, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Combobox } from "@/platform/ui/combobox";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { ForwardForm } from "../forward-form";

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
  /** The person's visible total. */
  strikes: number;
  /** Where this row falls in that person's sequence (1 = their first). */
  ordinal: number;
  /** Total at or above which clinic policy considers the limit reached. */
  strikeThreshold: number;
  canManageAll: boolean;
  /** Report options for the link control. Empty for non-central viewers. */
  reportOptions: Array<{ value: string; label: string }>;
  deleteAction: (formData: FormData) => Promise<void>;
  linkReport: (formData: FormData) => Promise<void>;
  /** Previously used addresses, offered as suggestions on the forward field. */
  suggestions?: string[];
  /** Past disclosures of THIS strike, newest first. */
  forwards?: Array<{
    id: string;
    toEmail: string;
    note: string | null;
    forwardedByName: string;
  }>;
  forwardStrike?: (formData: FormData) => Promise<void>;
};

export function StrikeRow({
  action,
  personName,
  issuedByName,
  strikes,
  ordinal,
  strikeThreshold,
  canManageAll,
  reportOptions,
  deleteAction,
  linkReport,
  suggestions = [],
  forwards = [],
  forwardStrike,
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
        {/* "2 of 4" reads as: this was their 2nd strike, and they have 4 now.
            The bare total that used to sit here was identical on every row for
            the same person, so a strike from two years ago displayed as their
            CURRENT count with nothing to say otherwise. */}
        <TD className="tabular-nums text-sm font-medium text-foreground-soft whitespace-nowrap">
          <span>
            {ordinal} of {strikes}
          </span>
          {strikes >= strikeThreshold && (
            <Badge tone="critical" className="ml-1.5">
              Limit reached
            </Badge>
          )}
        </TD>
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

            {/* Forwarding outside the clinic. Hidden entirely for a confidential
                strike, which forwardStrike refuses server-side: it arises from an
                anonymous report and is withheld even from the subject's own
                directors, so offering the control would advertise an action that
                can only fail. */}
            {canManageAll && !action.confidential && (
              <div className="sm:col-span-2">
                <dt className="font-medium text-foreground">Forwarded outside the clinic</dt>
                {forwards.length > 0 ? (
                  <dd className="mt-1 space-y-1 text-foreground-soft">
                    {forwards.map((f) => (
                      <div key={f.id}>
                        Sent to <span className="text-foreground">{f.toEmail}</span> by{" "}
                        {f.forwardedByName}
                        {f.note && <span className="block text-xs">&ldquo;{f.note}&rdquo;</span>}
                      </div>
                    ))}
                  </dd>
                ) : (
                  <dd className="mt-1 text-foreground-soft">Not forwarded.</dd>
                )}
                {forwardStrike && (
                  <dd className="mt-2">
                    <ForwardForm
                      action={forwardStrike}
                      targetIdName="actionId"
                      targetId={action.id}
                      suggestions={suggestions}
                    />
                  </dd>
                )}
              </div>
            )}
          </dl>
        </TD>
      </TR>
    </>
  );
}
