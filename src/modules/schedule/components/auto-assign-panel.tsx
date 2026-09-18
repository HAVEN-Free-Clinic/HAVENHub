"use client";

/**
 * Generate a term's volunteer schedule, review it, then place it.
 *
 * Nothing is written until the director presses Place. The preview is the whole
 * point of the feature: an allocator nobody can inspect is one nobody will run
 * twice, so every row is listed, every row can be unticked, and each date says
 * how full it ended up and why it is not fuller.
 *
 * Rows are grouped by clinic date rather than by person because that is the
 * question being answered here ("is this Saturday covered?"). The per-person
 * view already exists, as the grid.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { EmptyState } from "@/platform/ui/empty-state";
import { Modal } from "@/platform/ui/modal";
import { Spinner } from "@/platform/ui/spinner";
import { useBulkSelection } from "@/platform/ui/use-bulk-selection";
import { displayDate } from "@/modules/schedule/engine/display";
import type { AutoAssignPreview } from "@/modules/schedule/services/auto-assign";

type Row = { dateKey: string; memberId: string };

const rowId = (r: Row) => `${r.dateKey}|${r.memberId}`;

export function AutoAssignPanel({
  termId,
  departmentId,
  deptCode,
}: {
  termId: string;
  departmentId: string;
  deptCode: string;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<AutoAssignPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(body: unknown): Promise<Response> {
    return fetch("/api/schedule/auto-assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await call({ termId, departmentId, kind: "preview" });
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? "Could not generate a schedule.");
        return;
      }
      setPreview((await res.json()) as AutoAssignPreview);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function place(additions: readonly Row[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await call({ termId, departmentId, kind: "apply", additions });
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? "Could not place the schedule.");
        return;
      }
      setPreview(null);
      // The board and every server-rendered panel beside it are now stale.
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={generate} disabled={busy}>
        {busy && !preview ? <Spinner /> : null}
        Generate schedule
      </Button>

      {error && !preview ? (
        <Alert tone="error" className="mt-2">
          {error}
        </Alert>
      ) : null}

      {/* Mounted only once a proposal exists, which is load-bearing rather than
          tidiness: useBulkSelection seeds its preselection ONCE, from the rows it
          is given at mount. Called from the panel it would mount against an empty
          proposal, tick nothing, and leave Place disabled at "Place 0 shifts"
          forever. An e2e caught exactly that. */}
      {preview !== null ? (
        <ProposalReview
          preview={preview}
          deptCode={deptCode}
          busy={busy}
          error={error}
          onClose={() => setPreview(null)}
          onPlace={place}
        />
      ) : null}
    </>
  );
}

function ProposalReview({
  preview,
  deptCode,
  busy,
  error,
  onClose,
  onPlace,
}: {
  preview: AutoAssignPreview;
  deptCode: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onPlace: (additions: readonly Row[]) => void | Promise<void>;
}) {
  const rows: Row[] = [...preview.proposal.additions];
  const selection = useBulkSelection({ rows, idOf: rowId, initial: () => true });

  const byDate = new Map<string, Row[]>();
  for (const r of rows) {
    byDate.set(r.dateKey, [...(byDate.get(r.dateKey) ?? []), r]);
  }

  const chosen = new Set(selection.ids);
  const picked = rows.filter((r) => chosen.has(rowId(r)));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Generated schedule for ${deptCode}`}
      size="large"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => onPlace(picked)}
            disabled={busy || picked.length === 0}
          >
            {busy ? <Spinner /> : null}
            {`Place ${picked.length} shift${picked.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      }
    >
      {error ? (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <div className="space-y-4">
        <div className="text-sm text-foreground-soft">
          Existing assignments are never moved or removed: this only fills empty seats, and
          nothing is written until you press Place.
        </div>

        {preview.dateKeys.map((dateKey) => {
          const report = preview.proposal.dates.find((d) => d.dateKey === dateKey);
          const group = byDate.get(dateKey) ?? [];
          const groupIds = group.map(rowId);
          return (
            <section key={dateKey} className="rounded-xl border border-border p-3">
              <header className="mb-2 flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={selection.allOf(groupIds)}
                  onChange={(e) => selection.setMany(groupIds, e.target.checked)}
                  aria-label={`Select every proposed shift on ${dateKey}`}
                />
                <span className="font-medium text-foreground">{displayDate(dateKey)}</span>
                {report ? (
                  <>
                    <Badge tone={report.after === 0 ? "critical" : "default"}>
                      {`${report.after}${report.cap !== null ? ` / ${report.cap}` : ""} volunteers`}
                    </Badge>
                    {report.shortBy > 0 ? (
                      <span className="text-xs text-foreground-soft">
                        {report.available <= report.after
                          ? "Everyone available is already on it."
                          : `${report.shortBy} seat${report.shortBy === 1 ? "" : "s"} still free.`}
                      </span>
                    ) : null}
                    {report.interpreterCover === "BELOW_BAR" ||
                    report.interpreterCover === "UNKNOWN" ? (
                      <Badge tone="warning">No assessed interpreter</Badge>
                    ) : null}
                  </>
                ) : null}
              </header>

              {group.length === 0 ? (
                <EmptyState inline>Nothing new proposed for this date.</EmptyState>
              ) : (
                <ul className="space-y-1">
                  {group.map((r) => (
                    <li key={rowId(r)} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selection.has(rowId(r))}
                        onChange={() => selection.toggle(rowId(r))}
                        aria-label={`Place ${preview.names[r.memberId] ?? r.memberId} on ${dateKey}`}
                      />
                      <span>{preview.names[r.memberId] ?? r.memberId}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
