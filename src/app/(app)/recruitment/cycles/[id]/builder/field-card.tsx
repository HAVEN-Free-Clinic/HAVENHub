"use client";
import { useState, useTransition, type HTMLAttributes } from "react";
import { Copy, GripVertical, Pencil, Check, AlertCircle } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { FieldPreview, type PreviewFieldDef } from "@/modules/recruitment/components/field-preview";
import { FIELD_TYPE_META, fieldTypesByGroup } from "@/modules/recruitment/engine/field-types";
import { parseFieldCondition, type FieldCondition, type FieldConditionOp } from "@/modules/recruitment/engine/field-visibility";
import { updateFieldAction, deleteFieldAction, duplicateFieldAction } from "./actions";
import { OptionsEditor } from "./options-editor";
import type { Choice } from "@/modules/recruitment/engine/options";
import { DEFAULT_ACKNOWLEDGE_LABEL, isDisplayOnlyNotice, noticeAcknowledgeLabel, noticeDisplayLabel } from "@/modules/recruitment/engine/notice";
import { AVAILABILITY_FIELD_KEY } from "@/modules/recruitment/templates/clinic-dates";
import type { SortableHandleProps } from "./sortable-list";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Card } from "@/platform/ui/card";

export type BuilderField = PreviewFieldDef & { id: string; correctValue: string | null; visibleWhen: unknown };

/** The field's validation blob with the notice-acknowledgement keys stripped, so
 *  turning the tick off leaves no stale `acknowledgeLabel` to resurface if it is
 *  turned back on later. */
function omitAcknowledgement(validation: Record<string, unknown> | null): Record<string, unknown> {
  const { acknowledge: _a, acknowledgeLabel: _l, ...rest } = validation ?? {};
  return rest;
}

const FILE_TYPE_CHOICES: { label: string; value: string }[] = [
  { label: "PDF", value: "application/pdf" },
  { label: "Word", value: "application/msword" },
  { label: "Images", value: "image/*" },
];

/** The value-side options for a controlling field's "Show only when" condition:
 *  a dropdown of its choices for a select-like field, a synthetic single
 *  "Checked" choice for a checkbox, the cycle's departments for the
 *  department picker, or null (free-text input) for anything else. */
function conditionValueOptions(
  controllingField: BuilderField | undefined,
  departments: string[],
): { value: string; label: string }[] | null {
  if (!controllingField) return null;
  // An acknowledging notice stores a checkbox answer, so it offers the same
  // single "Checked" choice. A display-only one never reaches here -- it is not
  // offered as a controller at all (see `otherFields` in FieldCard).
  if (controllingField.type === "CHECKBOX" || controllingField.type === "NOTICE") return [{ value: "on", label: "Checked" }];
  if (controllingField.type === "DEPARTMENT_CHOICE") return departments.map((d) => ({ value: d, label: d }));
  return controllingField.options && controllingField.options.length > 0 ? controllingField.options : null;
}

function VisibleWhenEditor({
  visibleWhen, siblingFields, departments, disabled, onChange,
}: {
  visibleWhen: unknown;
  siblingFields: BuilderField[];
  departments: string[];
  disabled: boolean;
  onChange: (cond: FieldCondition | null) => void;
}) {
  const parsed = parseFieldCondition(visibleWhen);
  const controllingKey = parsed?.field ?? "";
  const controllingField = siblingFields.find((f) => f.key === controllingKey);
  const op: FieldConditionOp = parsed?.op ?? "is";
  const opts = conditionValueOptions(controllingField, departments);
  const selectedValues = op === "isAnyOf" ? (Array.isArray(parsed?.value) ? parsed.value : []) : [];
  const singleValue = op !== "isAnyOf" && typeof parsed?.value === "string" ? parsed.value : "";

  function handleFieldChange(key: string) {
    if (!key) { onChange(null); return; }
    onChange(parseFieldCondition({ field: key, op: "isAnswered" }));
  }
  function handleOpChange(nextOp: FieldConditionOp) {
    if (!controllingKey) return;
    if (nextOp === "isAnswered") { onChange(parseFieldCondition({ field: controllingKey, op: nextOp })); return; }
    if (nextOp === "isAnyOf") { onChange(parseFieldCondition({ field: controllingKey, op: nextOp, value: [] })); return; }
    onChange(parseFieldCondition({ field: controllingKey, op: nextOp, value: "" }));
  }
  function handleSingleValueChange(v: string) {
    if (!controllingKey) return;
    onChange(parseFieldCondition({ field: controllingKey, op, value: v }));
  }
  function handleMultiValueChange(values: string[]) {
    if (!controllingKey) return;
    onChange(parseFieldCondition({ field: controllingKey, op, value: values }));
  }

  return (
    <Field label="Show only when" hint="Hide this question unless another answer matches. Leave as (always show) for no condition.">
      {/* min-w-0 on the row and on each Select: a native <select> is intrinsically
          as wide as its longest <option>, so one long field label would otherwise
          stretch this row past the card edge. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select className="min-w-0" disabled={disabled} value={controllingKey} onChange={(e) => handleFieldChange(e.target.value)}>
          <option value="">(always show)</option>
          {controllingKey && !controllingField && <option value={controllingKey} disabled>{controllingKey} (deleted field)</option>}
          {siblingFields.map((f) => <option key={f.key} value={f.key}>{f.type === "NOTICE" ? noticeDisplayLabel(f) : f.label}</option>)}
        </Select>
        {controllingKey && (
          <>
            <Select className="min-w-0" disabled={disabled} value={op} onChange={(e) => handleOpChange(e.target.value as FieldConditionOp)}>
              <option value="is">is</option>
              <option value="isNot">is not</option>
              <option value="isAnswered">is answered</option>
              <option value="isAnyOf">is any of</option>
            </Select>
            {op !== "isAnswered" && op !== "isAnyOf" && (
              opts ? (
                <Select className="min-w-0" disabled={disabled} value={singleValue} onChange={(e) => handleSingleValueChange(e.target.value)}>
                  <option value="" disabled>Select…</option>
                  {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : (
                <Input disabled={disabled} defaultValue={singleValue}
                  onBlur={(e) => handleSingleValueChange(e.target.value.trim())} />
              )
            )}
            {op === "isAnyOf" && (
              opts ? (
                // A native <select multiple> replaces the whole selection on a plain
                // click (only ctrl/cmd-click adds), which reads as "can only pick one"
                // and is near-unusable on touch. A checkbox group toggles per single
                // tap and is keyboard/touch friendly.
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {opts.map((o) => (
                    <label key={o.value} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        disabled={disabled}
                        checked={selectedValues.includes(o.value)}
                        onChange={(e) =>
                          handleMultiValueChange(
                            e.target.checked
                              ? [...selectedValues, o.value]
                              : selectedValues.filter((v) => v !== o.value),
                          )
                        }
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              ) : (
                <Input disabled={disabled} defaultValue={selectedValues.join(", ")}
                  placeholder="comma-separated values"
                  onBlur={(e) => handleMultiValueChange(e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} />
              )
            )}
          </>
        )}
      </div>
    </Field>
  );
}

export function FieldCard({
  cycleId, field, siblingFields, departments, subcommittees, editable, handle, onChanged,
}: {
  cycleId: string;
  field: BuilderField;
  siblingFields: BuilderField[];
  departments: string[];
  subcommittees: { id: string; name: string }[];
  editable: boolean;
  handle: SortableHandleProps;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = FIELD_TYPE_META[field.type as FieldType];
  const Icon = meta.icon;
  // A notice is content, not a question, so most of the editor below is
  // meaningless for it: it has no answer to require, no choices, no validation.
  // What it does have is an OPTIONAL heading and a multi-line body, which is why
  // the two text inputs swap shape rather than a second editor being grown.
  const isNotice = field.type === "NOTICE";
  const ackLabel = isNotice ? noticeAcknowledgeLabel(field.validation) : null;
  const accepted = Array.isArray(field.validation?.acceptedTypes) ? (field.validation!.acceptedTypes as string[]) : [];
  // Candidate controllers for a "show only when" condition. A display-only
  // notice is excluded: it holds no answer, so a condition keyed to it could
  // never become true and the field it gates would simply never appear.
  const otherFields = siblingFields.filter((f) => f.key !== field.key && !isDisplayOnlyNotice(f));

  function save(patch: Parameters<typeof updateFieldAction>[2]) {
    setError(null);
    startTransition(async () => {
      const res = await updateFieldAction(cycleId, field.id, patch);
      if (res.ok) { setSaved(true); onChanged(); setTimeout(() => setSaved(false), 1500); }
      else setError(res.error);
    });
  }

  return (
    <Card size="compact" className="group">
      <div className="flex items-start gap-2">
        {/* eslint-disable-next-line no-restricted-syntax -- DnD drag-handle button, needs raw attribute/listener spread for dnd-kit */}
        <button type="button" className="mt-1 cursor-grab text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 disabled:cursor-not-allowed" disabled={!editable} aria-label="Drag to reorder field" {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)} {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}>
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        {/* min-w-0: a flex item's min-width defaults to auto, so a long label or
            help string sized this column to its content and pushed the card (and
            the page) wider instead of wrapping inside it. */}
        <div className="min-w-0 flex-1">
          <FieldPreview f={field} departments={departments} subcommittees={subcommittees} disabled />
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <span title={meta.label} className="px-1 text-subtle-foreground"><Icon className="h-4 w-4" aria-hidden /></span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-label="Edit field"><Pencil className="h-4 w-4" aria-hidden /></Button>
          <Button type="button" variant="ghost" size="sm" disabled={!editable || pending}
            onClick={() => { setError(null); startTransition(async () => { const r = await duplicateFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); }); }}
            aria-label="Duplicate field"><Copy className="h-4 w-4" aria-hidden /></Button>
          <form action={async () => { setError(null); const r = await deleteFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); }}>
            <ConfirmButton label="Remove" size="sm" disabled={!editable} />
          </form>
        </div>
      </div>

      {(saved || error) && (
        <p className={`mt-1 flex items-center gap-1 break-words text-xs [overflow-wrap:anywhere] ${error ? "text-critical-foreground" : "text-subtle-foreground"}`}>
          {error ? <><AlertCircle className="h-3 w-3" aria-hidden /> {error}</> : <><Check className="h-3 w-3" aria-hidden /> Saved</>}
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
          {/* A blank label is rejected for a question (an unlabelled input is
              unanswerable) but is the NORMAL case for a notice, whose heading is
              optional -- the notices this was built for are a bare paragraph. */}
          <Field label={isNotice ? "Heading" : "Label"} hint={isNotice ? "Optional. Leave blank for a notice with no heading." : undefined}>
            <Input defaultValue={field.label} onBlur={(e) => { const v = e.target.value.trim(); if ((v || isNotice) && v !== field.label) save({ label: v }); }} />
          </Field>
          <Field label={isNotice ? "Notice text" : "Help text"} hint={isNotice ? "The body of the callout. Blank lines between paragraphs are kept, and links are made clickable." : "Shown under the field."}>
            {isNotice ? (
              <Textarea rows={4} defaultValue={field.helpText ?? ""} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (field.helpText ?? "")) save({ helpText: v }); }} />
            ) : (
              <Input defaultValue={field.helpText ?? ""} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (field.helpText ?? "")) save({ helpText: v }); }} />
            )}
          </Field>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Type">
              <Select defaultValue={field.type} disabled={!editable} onChange={(e) => save({ type: e.target.value as FieldType })}>
                {fieldTypesByGroup().map(({ group, types }) => (
                  <optgroup key={group} label={group}>
                    {types.map((t) => <option key={t} value={t}>{FIELD_TYPE_META[t].label}</option>)}
                  </optgroup>
                ))}
              </Select>
            </Field>
            {(!isNotice || ackLabel !== null) && (
              <label className="flex items-center gap-2 py-2 text-sm text-foreground-soft">
                <Checkbox defaultChecked={field.required} disabled={!editable && !field.required}
                  onChange={(e) => save({ required: e.target.checked })} /> {isNotice ? "Must be ticked to continue" : "Required"}
              </label>
            )}
          </div>

          {isNotice && (
            <div className="space-y-3">
              {/* Turning the tick on defaults it to required, because a
                  confirmation nobody has to give records nothing; turning it off
                  MUST clear required in the same save, or the notice is left
                  required with no control to satisfy it and the wizard blocks
                  the applicant on a field they cannot see. */}
              <label className="flex items-center gap-2 py-1 text-sm text-foreground-soft">
                <Checkbox
                  checked={ackLabel !== null}
                  disabled={!editable}
                  onChange={(e) =>
                    save(
                      e.target.checked
                        ? { validation: { ...(field.validation ?? {}), acknowledge: true }, required: true }
                        : { validation: omitAcknowledgement(field.validation), required: false },
                    )
                  }
                />{" "}
                Ask applicants to confirm they have read this
              </label>
              {ackLabel !== null && (
                <Field label="Confirmation text">
                  <Input
                    defaultValue={ackLabel}
                    disabled={!editable}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || DEFAULT_ACKNOWLEDGE_LABEL;
                      if (v !== ackLabel) save({ validation: { ...(field.validation ?? {}), acknowledge: true, acknowledgeLabel: v } });
                    }}
                  />
                </Field>
              )}
            </div>
          )}

          {meta.hasOptions && (
            <Field label="Choices">
              <OptionsEditor options={(field.options ?? []) as Choice[]}
                disabled={!editable || field.key === AVAILABILITY_FIELD_KEY}
                onChange={(next) => save({ options: next })} />
              {field.key === AVAILABILITY_FIELD_KEY && (
                <p className="mt-2 text-sm text-muted-foreground">
                  These dates come from the term&rsquo;s clinic calendar and update automatically.
                  Change them in Admin, Terms, Clinic dates.
                </p>
              )}
            </Field>
          )}

          {meta.isFile && (
            <Field label="Accepted file types">
              <div className="flex flex-wrap gap-3">
                {FILE_TYPE_CHOICES.map((c) => (
                  <label key={c.value} className="flex items-center gap-2 text-sm">
                    <Checkbox defaultChecked={accepted.includes(c.value)} disabled={!editable}
                      onChange={(e) => {
                        const next = e.target.checked ? [...accepted, c.value] : accepted.filter((a) => a !== c.value);
                        save({ validation: { ...(field.validation ?? {}), acceptedTypes: next } });
                      }} /> {c.label}
                  </label>
                ))}
              </div>
            </Field>
          )}

          {field.type === "DEPARTMENT_CHOICE" && (
            <p className="text-xs text-subtle-foreground">Choices come from this cycle&apos;s departments automatically.</p>
          )}

          {field.type === "SUBCOMMITTEE_RANK" && (
            <Field label="Number to rank" hint="How many ordered choices the applicant makes. Choices come from active subcommittees.">
              <Input
                type="number"
                min={1}
                max={5}
                defaultValue={String((field.validation?.rankCount as number | undefined) ?? 3)}
                disabled={!editable}
                onBlur={(e) => {
                  const n = Math.max(1, Math.min(5, Number(e.target.value) || 3));
                  const current = (field.validation?.rankCount as number | undefined) ?? 3;
                  if (n !== current) save({ validation: { ...(field.validation ?? {}), rankCount: n } });
                }}
              />
            </Field>
          )}

          {field.type === "LONG_TEXT" && (
            <Field label="Word limit" hint="Optional. Shows applicants a soft counter like 127 / 300 words; it does not block submission. Leave blank for no counter.">
              <Input
                type="number"
                min={1}
                placeholder="No limit"
                defaultValue={typeof field.validation?.wordLimit === "number" ? String(field.validation.wordLimit) : ""}
                disabled={!editable}
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  const parsed = raw === "" ? 0 : Math.floor(Number(raw) || 0);
                  // Blank or 0 clears the limit (drop the key so no counter shows).
                  const next = parsed > 0 ? parsed : undefined;
                  const current = typeof field.validation?.wordLimit === "number" ? field.validation.wordLimit : undefined;
                  if (next === current) return;
                  const validation: Record<string, unknown> = { ...(field.validation ?? {}) };
                  if (next === undefined) delete validation.wordLimit;
                  else validation.wordLimit = next;
                  save({ validation });
                }}
              />
            </Field>
          )}

          {otherFields.length > 0 && (
            <VisibleWhenEditor
              visibleWhen={field.visibleWhen}
              siblingFields={otherFields}
              departments={departments}
              disabled={!editable}
              onChange={(cond) => save({ visibleWhen: cond })}
            />
          )}
        </div>
      )}
    </Card>
  );
}
