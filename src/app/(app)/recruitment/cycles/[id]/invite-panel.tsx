"use client";

/**
 * Invite-link management for a cycle: issue one, see the outstanding ones,
 * withdraw one.
 *
 * Client component for a single reason: the raw token exists for exactly one
 * render. It is returned by the server action, shown here so staff can copy it,
 * and is unrecoverable afterwards because only its hash was stored. Holding it in
 * component state (rather than, say, a query param) keeps it out of the URL bar,
 * out of browser history, and out of any server log that records request lines.
 */

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Field, Input } from "@/platform/ui/input";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { SectionHeader } from "@/platform/ui/section-header";

export type InviteRow = {
  id: string;
  label: string | null;
  createdByName: string;
  createdAtLabel: string;
  expiresAtLabel: string | null;
  claimedByEmailLower: string | null;
  revoked: boolean;
  expired: boolean;
};

type InvitePanelProps = {
  rows: InviteRow[];
  /** Returns the absolute claim URL, shown once. */
  createAction: (formData: FormData) => Promise<string>;
  revokeAction: (formData: FormData) => Promise<void>;
};

function statusOf(row: InviteRow): { label: string; tone: "default" | "success" | "warning" } {
  if (row.revoked) return { label: "Withdrawn", tone: "default" };
  if (row.claimedByEmailLower) return { label: "Accepted", tone: "success" };
  if (row.expired) return { label: "Expired", tone: "default" };
  return { label: "Outstanding", tone: "warning" };
}

export function InvitePanel({ rows, createAction, revokeAction }: InvitePanelProps) {
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(formData: FormData) {
    const url = await createAction(formData);
    setIssued(url);
    setCopied(false);
  }

  return (
    <div className="space-y-4">
      <div>
        <SectionHeader>Invitation links</SectionHeader>
        <p className="mt-1 text-sm text-muted-foreground">
          A single-use link that lets one person apply even when this cycle is closed. It works
          once, expires on its own, and is bound to whoever accepts it first.
        </p>
      </div>

      {issued && (
        <Alert tone="success">
          <p className="font-medium">Copy this link now. It is not shown again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-muted px-2 py-1 text-xs">{issued}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(issued);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Alert>
      )}

      <form action={handleCreate} className="flex flex-wrap items-end gap-2">
        <div className="w-72">
          <Field label="Label (optional)" hint="Who this is for, so you can recognize it later">
            <Input name="label" placeholder="e.g. info-session walk-up" />
          </Field>
        </div>
        <div className="w-40">
          <Field label="Expires in (days)">
            <Input name="ttlDays" type="number" min={1} max={365} defaultValue={14} />
          </Field>
        </div>
        <Button type="submit" variant="outline">
          Generate link
        </Button>
      </form>

      {rows.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH>Label</TH>
              <TH>Status</TH>
              <TH>Accepted by</TH>
              <TH>Issued</TH>
              <TH>Expires</TH>
              <TH />
            </TR>
          </THead>
          <tbody>
            {rows.map((row) => {
              const status = statusOf(row);
              return (
                <TR key={row.id}>
                  <TD>{row.label ?? <span className="text-subtle-foreground">-</span>}</TD>
                  <TD>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </TD>
                  <TD className="text-muted-foreground">
                    {row.claimedByEmailLower ?? <span className="text-subtle-foreground">-</span>}
                  </TD>
                  <TD className="text-muted-foreground">
                    {row.createdAtLabel} by {row.createdByName}
                  </TD>
                  <TD className="text-muted-foreground">
                    {row.expiresAtLabel ?? "Never"}
                  </TD>
                  <TD>
                    {/* Withdrawing stays available after acceptance: it is how an
                        invitation issued in error is taken back, and isInvitedTo
                        honours it even for someone who already claimed. */}
                    {!row.revoked && (
                      <form action={revokeAction}>
                        <input type="hidden" name="inviteId" value={row.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Withdraw
                        </Button>
                      </form>
                    )}
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
