"use client";

/**
 * TermBatchTab: the ITCM term roll-up.
 *
 * Shows every roster member on the selected term who needs an Epic request,
 * split into NEW / MODIFY / RENEW by kind derived from the roster (see
 * loadTermEpicRollup). Each group submits as one YNHH batch: the request rows and
 * the ticket are written by the generate route, which returns the service-request
 * PDF, the bulk spreadsheet, and the cover-email draft.
 *
 * Clearance is a warning, never a block. A row that is not fully cleared shows
 * the missing steps and starts unchecked so submitting it is deliberate. Rows the
 * service layer would refuse (non-active person, open deactivation, Epic ID that
 * contradicts the kind) and rows already submitted onto a ticket are not
 * selectable at all.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field, Input } from "@/platform/ui/input";
import { SectionHeader } from "@/platform/ui/section-header";
import { Select } from "@/platform/ui/select";
import { TermSwitcher } from "@/platform/ui/term-switcher";
import type { TermOption } from "@/platform/terms/term-options";
import { EPIC_KIND_LABELS } from "@/modules/support/labels";
import { requestTypeForGroup } from "@/modules/support/epic-request-types";
import type { EpicAuthorizer } from "@/modules/support/services/itcm";
import type {
  EpicRollup,
  EpicRollupRow,
  RollupGroupKind,
} from "@/modules/support/services/epic-rollup";
import { runEpicGeneration } from "./epic-generate-client";

const GROUPS: RollupGroupKind[] = ["NEW", "MODIFY", "RENEW"];

const GROUP_BLURB: Record<RollupGroupKind, string> = {
  NEW: "No Epic account on file. YNHH creates one mirroring a same-role account in their department.",
  MODIFY: "Has an Epic account that needs the HAVEN department added or changed.",
  RENEW: "Same departments as last term. Access is extended to the new end date.",
};

type Selection = Record<RollupGroupKind, Set<string>>;

function defaultSelection(rollup: EpicRollup): Selection {
  const out: Selection = { NEW: new Set(), MODIFY: new Set(), RENEW: new Set() };
  for (const group of GROUPS) {
    for (const row of rollup.groups[group]) {
      if (row.selectable && row.cleared && !row.optional) out[group].add(row.personId);
    }
  }
  return out;
}

export function TermBatchTab({
  rollup,
  authorizers,
  termOptions,
  liveTermId,
}: {
  rollup: EpicRollup;
  authorizers: EpicAuthorizer[];
  termOptions: TermOption[];
  liveTermId: string | null;
}) {
  const router = useRouter();
  const [authorizerId, setAuthorizerId] = useState(authorizers[0]?.id ?? "");
  const [endDate, setEndDate] = useState(rollup.term.endDateIso);
  const [selection, setSelection] = useState<Selection>(() => defaultSelection(rollup));
  const [busyGroup, setBusyGroup] = useState<RollupGroupKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ group: RollupGroupKind; subject: string; body: string } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  function toggle(group: RollupGroupKind, personId: string) {
    setError(null);
    setWarning(null);
    setSelection((prev) => {
      const next = new Set(prev[group]);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return { ...prev, [group]: next };
    });
  }

  async function submitGroup(group: RollupGroupKind) {
    const authorizer = authorizers.find((a) => a.id === authorizerId);
    if (!authorizer) {
      setError("No ITCM director is available to authorize this request.");
      return;
    }
    const personIds = [...selection[group]];
    if (personIds.length === 0) {
      setError(`Select at least one person in the ${EPIC_KIND_LABELS[group]} group.`);
      return;
    }
    if (!endDate) {
      setError("Set the access end date before submitting a batch.");
      return;
    }
    setError(null);
    setWarning(null);
    setDraft(null);
    setBusyGroup(group);
    try {
      const result = await runEpicGeneration({
        requestType: requestTypeForGroup(group, personIds.length),
        authorizer,
        personIds,
        endDate,
        termId: rollup.term.id,
      });
      setDraft({ group, subject: result.subject, body: result.body });
      if (result.trackingWarning) {
        setWarning(result.trackingWarning);
      } else {
        // The people just submitted are now SUBMITTED-and-ticketed server-side;
        // drop them from the local selection and ask the server to re-render the
        // rollup so their rows come back non-selectable instead of staying checked
        // and re-clickable. Skipped when tracking failed (trackingWarning set):
        // nothing was recorded server-side, so clearing here would force the
        // director to re-tick everyone by hand.
        setSelection((prev) => ({ ...prev, [group]: new Set() }));
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyGroup(null);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    const text = `To: helpdesk@ynhh.org\nSubject: ${draft.subject}\n\n${draft.body}`;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 4000);
    }
  }

  const total = GROUPS.reduce((n, g) => n + rollup.groups[g].length, 0);

  return (
    <div className="space-y-6">
      <TermSwitcher
        options={termOptions}
        selectedId={rollup.term.id}
        liveTermId={liveTermId}
        hrefForTerm={(termId) =>
          termId ? `/support/epic?tab=term-batch&term=${termId}` : "/support/epic?tab=term-batch"
        }
      />

      <Card className="space-y-4">
        <SectionHeader level="title">Batch settings</SectionHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Authorizer">
            <Select
              value={authorizerId}
              onChange={(e) => setAuthorizerId(e.target.value)}
              disabled={authorizers.length === 0}
            >
              {authorizers.length === 0 ? (
                <option value="">No ITCM directors</option>
              ) : (
                authorizers.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))
              )}
            </Select>
          </Field>
          <Field label="Access end date">
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {warning && (
        <Alert tone="warning">
          {warning}{" "}
          <Link href="/support/epic?tab=tracker" className="underline underline-offset-2">
            Open the Tracker
          </Link>
        </Alert>
      )}

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody on the {rollup.term.code} roster needs an Epic request. Members appear here once
          their department requires Epic access and they hold an active membership in this term.
        </p>
      ) : (
        GROUPS.map((group) => (
          <GroupCard
            key={group}
            group={group}
            rows={rollup.groups[group]}
            selected={selection[group]}
            busy={busyGroup === group}
            disabled={busyGroup !== null}
            onToggle={(personId) => toggle(group, personId)}
            onSubmit={() => submitGroup(group)}
          />
        ))
      )}

      {draft && (
        <Card className="space-y-3">
          <SectionHeader level="title">
            {EPIC_KIND_LABELS[draft.group]} email draft
          </SectionHeader>
          <p className="text-xs text-subtle-foreground">
            The PDF (and spreadsheet, for a multi-person batch) already downloaded. Send this to
            helpdesk@ynhh.org with them attached.
          </p>
          <p className="text-sm font-medium text-foreground">{draft.subject}</p>
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-xs text-foreground-soft">
            {draft.body}
          </pre>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={copyDraft}>
              Copy email
            </Button>
            <span
              aria-live="polite"
              className={`text-xs font-medium ${
                copyState === "copied"
                  ? "text-success-foreground"
                  : copyState === "error"
                    ? "text-critical-foreground"
                    : "text-muted-foreground"
              }`}
            >
              {copyState === "copied"
                ? "Copied to clipboard"
                : copyState === "error"
                  ? "Copy failed. Select the text above and copy manually."
                  : ""}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}

function GroupCard({
  group,
  rows,
  selected,
  busy,
  disabled,
  onToggle,
  onSubmit,
}: {
  group: RollupGroupKind;
  rows: EpicRollupRow[];
  selected: Set<string>;
  busy: boolean;
  disabled: boolean;
  onToggle: (personId: string) => void;
  onSubmit: () => void;
}) {
  const clearedCount = rows.filter((r) => r.cleared).length;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionHeader level="title">{EPIC_KIND_LABELS[group]}</SectionHeader>
        <span className="text-xs text-subtle-foreground">
          {rows.length} {rows.length === 1 ? "person" : "people"}, {clearedCount} cleared
        </span>
      </div>
      <p className="text-xs text-subtle-foreground">{GROUP_BLURB[group]}</p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody in this group.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <RollupRow
              key={row.personId}
              row={row}
              checked={selected.has(row.personId)}
              onToggle={() => onToggle(row.personId)}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={disabled || selected.size === 0}
          onClick={onSubmit}
        >
          {busy ? "Submitting..." : `Submit ${EPIC_KIND_LABELS[group].toLowerCase()} batch`}
        </Button>
        <span className="text-xs text-subtle-foreground">{selected.size} selected</span>
      </div>
    </Card>
  );
}

function RollupRow({
  row,
  checked,
  onToggle,
}: {
  row: EpicRollupRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const deptLabel =
    row.kind === "MODIFY" && row.priorDepartmentNames.length > 0
      ? `${row.priorDepartmentNames.join(", ")} -> ${row.departments.map((d) => d.name).join(", ")}`
      : row.departments.map((d) => d.name).join(", ");

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
      <Checkbox
        checked={checked}
        onChange={onToggle}
        disabled={!row.selectable}
        aria-label={`Select ${row.name}`}
      />
      <span className="font-medium text-foreground">{row.name}</span>
      <span className="text-xs text-subtle-foreground">{deptLabel}</span>

      {row.cleared ? (
        <Badge tone="success">Cleared</Badge>
      ) : (
        <Badge tone="warning">
          {row.missingLabels.length > 0 ? `Missing: ${row.missingLabels.join(", ")}` : "Not cleared"}
        </Badge>
      )}

      {row.optional && <Badge>Optional</Badge>}
      {row.kindSource === "ticket" && row.existingRequest?.techRequestNumber != null && (
        <Badge tone="brand">From ticket #{row.existingRequest.techRequestNumber}</Badge>
      )}
      {row.kindSource === "derived" && row.existingRequest?.status === "PENDING" && (
        <Badge>Queued</Badge>
      )}
      {row.existingRequest?.status === "SUBMITTED" && <Badge tone="brand">Already submitted</Badge>}
      {row.blockedReason && <Badge tone="critical">{row.blockedReason}</Badge>}
    </li>
  );
}
