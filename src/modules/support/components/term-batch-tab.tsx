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
import { useBulkSelection } from "@/platform/ui/use-bulk-selection";
import { useRouter } from "next/navigation";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { CopyButton } from "@/platform/ui/copy-button";
import { Field, Input } from "@/platform/ui/input";
import { SectionHeader } from "@/platform/ui/section-header";
import { Select } from "@/platform/ui/select";
import { TextLink } from "@/platform/ui/text-link";
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
import { EmptyState } from "@/platform/ui/empty-state";

const GROUPS: RollupGroupKind[] = ["NEW", "MODIFY", "RENEW"];

const GROUP_BLURB: Record<RollupGroupKind, string> = {
  NEW: "No Epic account on file. YNHH creates one mirroring a same-role account in their department.",
  MODIFY: "Has an Epic account that needs the HAVEN department added or changed.",
  RENEW: "Same departments as last term. Access is extended to the new end date.",
};

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
  // One flat selection across all three groups. They are disjoint by person --
  // buildEpicRollup pushes each personId into exactly one of NEW/MODIFY/RENEW --
  // so a single Set cannot conflate two rows, and the per-group headers below
  // scope themselves with allOf/someOf/setMany.
  //
  // The hook's scoping earns its keep after a successful submit: that calls
  // router.refresh(), which re-renders this component WITHOUT remounting it (the
  // key is the term id and the term has not changed). A person in another group
  // whose row came back non-selectable would otherwise stay ticked, stay
  // counted, and stay in the next batch's personIds.
  const selection = useBulkSelection({
    rows: GROUPS.flatMap((g) => rollup.groups[g]),
    idOf: (r) => r.personId,
    selectable: (r) => r.selectable,
    // Everyone who can go and is ready to go, minus the optional extras.
    initial: (r) => r.selectable && r.cleared && !r.optional,
  });
  const [busyGroup, setBusyGroup] = useState<RollupGroupKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ group: RollupGroupKind; subject: string; body: string } | null>(null);

  /** The selectable ids of one group, in render order. */
  function groupIds(group: RollupGroupKind): string[] {
    return rollup.groups[group].filter((r) => r.selectable).map((r) => r.personId);
  }

  /** What is actually ticked in one group, scoped to the rows on screen. */
  function selectedIn(group: RollupGroupKind): string[] {
    const ids = new Set(groupIds(group));
    return selection.ids.filter((id) => ids.has(id));
  }

  async function submitGroup(group: RollupGroupKind) {
    const authorizer = authorizers.find((a) => a.id === authorizerId);
    if (!authorizer) {
      setError("No ITCM director is available to authorize this request.");
      return;
    }
    const personIds = selectedIn(group);
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
        selection.setMany(personIds, false);
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyGroup(null);
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
          <TextLink href="/support/epic?tab=tracker">Open the Tracker</TextLink>
        </Alert>
      )}

      {total === 0 ? (
        <EmptyState inline>
          Nobody on the {rollup.term.code} roster needs an Epic request. Members appear here once
          their department requires Epic access and they hold an active membership in this term.
        </EmptyState>
      ) : (
        GROUPS.map((group) => (
          <GroupCard
            key={group}
            group={group}
            rows={rollup.groups[group]}
            selectedCount={selectedIn(group).length}
            allSelected={selection.allOf(groupIds(group))}
            someSelected={selection.someOf(groupIds(group))}
            isSelected={selection.has}
            busy={busyGroup === group}
            disabled={busyGroup !== null}
            onToggle={(personId, shiftKey) => {
              setError(null);
              setWarning(null);
              selection.toggle(personId, shiftKey);
            }}
            onToggleAll={(on) => {
              setError(null);
              setWarning(null);
              selection.setMany(groupIds(group), on);
            }}
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
          {/* Same call as epic-request-form: a long generated draft, so a
              silent failure would leave the reader retyping it. */}
          <CopyButton
            label="Copy email"
            value={`To: helpdesk@ynhh.org\nSubject: ${draft.subject}\n\n${draft.body}`}
            errorMessage="Copy failed. Select the text above and copy manually."
          />
        </Card>
      )}
    </div>
  );
}

function GroupCard({
  group,
  rows,
  selectedCount,
  allSelected,
  someSelected,
  isSelected,
  busy,
  disabled,
  onToggle,
  onToggleAll,
  onSubmit,
}: {
  group: RollupGroupKind;
  rows: EpicRollupRow[];
  /** Scoped to this group's selectable rows, so it cannot count a stale id. */
  selectedCount: number;
  allSelected: boolean;
  someSelected: boolean;
  isSelected: (personId: string) => boolean;
  busy: boolean;
  disabled: boolean;
  onToggle: (personId: string, shiftKey: boolean) => void;
  onToggleAll: (on: boolean) => void;
  onSubmit: () => void;
}) {
  const clearedCount = rows.filter((r) => r.cleared).length;
  const selectableCount = rows.filter((r) => r.selectable).length;
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
        <EmptyState inline>Nobody in this group.</EmptyState>
      ) : (
        <>
          {/* Select-all, per group. A director staffing a term ticks most of a
              list of forty; this and the shift-range on the rows below are what
              the other four bulk surfaces in the app already had. */}
          {selectableCount > 0 && (
            <Checkbox
              label={`Select all ${EPIC_KIND_LABELS[group].toLowerCase()}`}
              checked={allSelected}
              indeterminate={someSelected}
              onChange={(e) => onToggleAll(e.target.checked)}
              disabled={disabled}
            />
          )}
          <ul className="space-y-1">
            {rows.map((row) => (
              <RollupRow
                key={row.personId}
                row={row}
                checked={isSelected(row.personId)}
                onToggle={(shiftKey) => onToggle(row.personId, shiftKey)}
              />
            ))}
          </ul>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={disabled || selectedCount === 0}
          onClick={onSubmit}
        >
          {busy ? "Submitting…" : `Submit ${EPIC_KIND_LABELS[group].toLowerCase()} batch`}
        </Button>
        <span className="text-xs text-subtle-foreground">{selectedCount} selected</span>
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
  onToggle: (shiftKey: boolean) => void;
}) {
  const deptLabel =
    row.kind === "MODIFY" && row.priorDepartmentNames.length > 0
      ? `${row.priorDepartmentNames.join(", ")} -> ${row.departments.map((d) => d.name).join(", ")}`
      : row.departments.map((d) => d.name).join(", ");

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
      <Checkbox
        checked={checked}
        // onClick, not onChange: a change event carries no shiftKey, and the
        // range is what makes a forty-person group workable.
        onClick={(e) => onToggle(e.shiftKey)}
        onChange={() => {}}
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
