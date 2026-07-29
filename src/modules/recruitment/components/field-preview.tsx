import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { linkifyUrls } from "@/platform/ui/form";
import { asPrefillList, isPrefillChecked, prefillString } from "./field-prefill";
import { WordCountTextarea } from "./word-count-textarea";
import { cx } from "@/platform/ui/cx";

export type PreviewFieldDef = {
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  required: boolean;
  options: { value: string; label: string }[] | null;
  validation: Record<string, unknown> | null;
};

// Reads the current value(s) for `name` back out of the owning <form> via
// FormData. Used for the group controls (MULTI_SELECT, SUBCOMMITTEE_RANK)
// where several inputs share one name and the changed control alone does not
// carry the full set of selected values.
function namedFormValues(el: HTMLInputElement | HTMLSelectElement, name: string): string[] {
  const form = el.form;
  if (!form) return [];
  return new FormData(form).getAll(name).filter((v): v is string => typeof v === "string");
}

export function FieldPreview({
  f, departments, subcommittees = [], fieldError, onValueChange, disabled = false, prefill, locked = false,
}: {
  f: PreviewFieldDef;
  departments: string[];
  subcommittees?: { id: string; name: string }[];
  fieldError?: string;
  // Notifies the caller of the field's current value on every change, keyed by
  // field key. Controls stay uncontrolled (defaultValue/defaultChecked); this
  // only adds a notification so a caller can react (e.g. re-evaluate other
  // fields' visibleWhen conditions) without taking over the control.
  onValueChange?: (key: string, value: string | string[]) => void;
  disabled?: boolean;
  // A draft/renewal answer: string (text, single-select), string[] (multi-select,
  // subcommittee rank), or a file-reference object. Narrowed per control below.
  prefill?: unknown;
  locked?: boolean;
}) {
  const required = f.required;
  // Wire the error message to the control: aria-invalid flags it, aria-describedby
  // points at the message so a screen reader reads *why* the field is invalid (not
  // just "invalid entry"). Id derived from the field key -- unique within the form
  // and hook-free, so this stays usable in a server render. Mirrors contract-field.tsx.
  const errorId = fieldError ? `fp-${f.key}-error` : undefined;
  const errorAria = fieldError ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const req = required ? <span className="text-critical" aria-hidden="true"> *</span> : null;
  const help = f.helpText ? <span className="mt-1 block text-xs text-muted-foreground">{linkifyUrls(f.helpText)}</span> : null;
  const err = fieldError ? <span id={errorId} role="alert" className="mt-1 block text-xs text-critical">{fieldError}</span> : null;

  // Prefill for text-like inputs: a locked field is read-only (verified value);
  // otherwise it seeds an editable default. Read-only controlled inputs do not
  // trigger React warnings.
  const hasText = typeof prefill === "string";
  const textValue = prefillString(prefill);
  const textProps = !hasText ? {} : locked ? { value: textValue, readOnly: true } : { defaultValue: textValue };
  const lockedCls = hasText && locked ? "bg-muted text-muted-foreground" : null;

  if (f.type === "CHECKBOX") {
    return (
      <div>
        <label className={cx("flex min-h-[44px] items-start gap-2.5 py-1", disabled ? "cursor-default" : "cursor-pointer")}>
          <Checkbox name={f.key} required={required} disabled={disabled} {...errorAria} className="mt-0.5" defaultChecked={isPrefillChecked(prefill)} onChange={(e) => onValueChange?.(f.key, e.target.checked ? "on" : "")} />
          <span className="text-sm text-foreground">{f.label}{req}</span>
        </label>
        {help}
        {err}
      </div>
    );
  }

  const onTextChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValueChange?.(f.key, e.target.value);
  const labelEl = <span className="block text-sm font-medium text-foreground">{f.label}{req}</span>;
  let control: React.ReactNode;
  switch (f.type) {
    case "LONG_TEXT": {
      const wl = f.validation?.wordLimit;
      const wordLimit = typeof wl === "number" ? wl : null;
      control = <WordCountTextarea name={f.key} required={required} disabled={disabled} {...errorAria} className={cx("mt-1.5", lockedCls)} wordLimit={wordLimit} onChange={onTextChange} {...textProps} />;
      break;
    }
    case "NUMBER": control = <Input type="number" name={f.key} required={required} disabled={disabled} {...errorAria} className={cx("mt-1.5", lockedCls)} onChange={onTextChange} {...textProps} />; break;
    case "DATE": control = <Input type="date" name={f.key} required={required} disabled={disabled} {...errorAria} className={cx("mt-1.5", lockedCls)} onChange={onTextChange} {...textProps} />; break;
    case "EMAIL": control = <Input type="email" name={f.key} required={required} disabled={disabled} {...errorAria} className={cx("mt-1.5", lockedCls)} onChange={onTextChange} {...textProps} />; break;
    case "PHONE": control = <Input type="tel" name={f.key} required={required} disabled={disabled} {...errorAria} className={cx("mt-1.5", lockedCls)} onChange={onTextChange} {...textProps} />; break;
    case "FILE": {
      const accept = Array.isArray(f.validation?.acceptedTypes) ? (f.validation!.acceptedTypes as string[]).join(",") : undefined;
      // A resumed draft stores the upload as { storedName, fileName, ... }. storedName is
      // the server's source of truth for "a file is already attached" (submissions.ts), so
      // gate on it and surface fileName as the label.
      const draftFile =
        prefill && typeof prefill === "object" && "storedName" in (prefill as object)
          ? (prefill as { fileName?: string })
          : null;
      control = (
        <>
          <Input
            type="file"
            name={f.key}
            required={required && !draftFile}
            disabled={disabled}
            {...errorAria}
            accept={accept}
            className="mt-1.5 cursor-pointer"
          />
          {draftFile && (
            <span className="mt-1 block text-xs text-muted-foreground">Attached: {draftFile.fileName ?? "uploaded file"}</span>
          )}
        </>
      );
      break;
    }
    case "DEPARTMENT_CHOICE": {
      // f.options carries resolved { value: code, label: name } pairs when the
      // caller has injected them (the live apply page). The form builder's own
      // preview never injects options -- nothing authors them there -- so this
      // falls back to the raw `departments` codes; removing the fallback would
      // blank the builder's dropdown.
      const deptOptions = f.options ?? departments.map((d) => ({ value: d, label: d }));
      control = <Select name={f.key} required={required} disabled={disabled} {...errorAria} className="mt-1.5" onChange={(e) => onValueChange?.(f.key, e.target.value)} defaultValue={prefillString(prefill)}><option value="" disabled>Select…</option>{deptOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
      break;
    }
    case "SINGLE_SELECT":
      control = <Select name={f.key} required={required} disabled={disabled} {...errorAria} className="mt-1.5" onChange={(e) => onValueChange?.(f.key, e.target.value)} defaultValue={prefillString(prefill)}><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
      break;
    case "MULTI_SELECT": {
      const selected = new Set(asPrefillList(prefill));
      const onMultiChange = (e: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(f.key, namedFormValues(e.target, f.key));
      control = (
        <span className="mt-1 flex flex-col">
          {(f.options ?? []).map((o) => (
            <label key={o.value} className={cx("flex min-h-[44px] items-center gap-2.5 py-1 text-sm text-foreground", disabled ? "cursor-default" : "cursor-pointer")}>
              <Checkbox name={f.key} value={o.value} disabled={disabled} defaultChecked={selected.has(o.value)} onChange={onMultiChange} /> {o.label}
            </label>
          ))}
        </span>
      );
      break;
    }
    case "SUBCOMMITTEE_RANK": {
      const rankCount = typeof f.validation?.rankCount === "number" ? f.validation.rankCount : 3;
      const ordinals = ["1st choice", "2nd choice", "3rd choice", "4th choice", "5th choice"];
      const ranks = asPrefillList(prefill); // one entry per rank, "" for an unranked slot
      const onRankChange = (e: React.ChangeEvent<HTMLSelectElement>) => onValueChange?.(f.key, namedFormValues(e.target, f.key));
      control = (
        <span className="mt-1 flex flex-col gap-2">
          {Array.from({ length: rankCount }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{ordinals[i] ?? `Choice ${i + 1}`}</span>
              <Select name={f.key} required={f.required && i === 0} disabled={disabled} defaultValue={ranks[i] ?? ""} className="flex-1" onChange={onRankChange}>
                <option value="">{i === 0 && f.required ? "Select…" : "None"}</option>
                {subcommittees.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
          ))}
          <span className="text-xs text-muted-foreground">Choose a different subcommittee for each rank.</span>
        </span>
      );
      break;
    }
    case "SIGNATURE":
      control = (
        <div className="mt-1.5 flex h-24 items-center justify-center rounded-lg border border-dashed border-border-strong bg-muted text-xs text-muted-foreground">
          Applicant will sign here
        </div>
      );
      break;
    default: control = <Input type="text" name={f.key} required={required} disabled={disabled} {...errorAria} className={cx("mt-1.5", lockedCls)} onChange={onTextChange} {...textProps} />;
  }
  // Group field types (MULTI_SELECT, SUBCOMMITTEE_RANK) render multiple controls,
  // so wrapping them in one <label> would nest labels (invalid) or bind the group
  // name to only the first control. Use a fieldset/legend for those; a single
  // <label> keeps implicit association for all single-control types.
  if (f.type === "MULTI_SELECT" || f.type === "SUBCOMMITTEE_RANK") {
    return (
      <fieldset className="block min-w-0 border-0 p-0">
        <legend className="block p-0 text-sm font-medium text-foreground">{f.label}{req}</legend>
        {help}{control}{err}
      </fieldset>
    );
  }
  return <label className="block">{labelEl}{help}{control}{err}</label>;
}
