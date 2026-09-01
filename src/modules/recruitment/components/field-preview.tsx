import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { linkifyUrls } from "@/platform/ui/form";
import { noticeAcknowledgeLabel } from "../engine/notice";
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
  const req = required ? <span className="text-critical-foreground" aria-hidden="true"> *</span> : null;
  // Label, help and error all take break-words + overflow-wrap:anywhere: an author
  // can paste a wall of text (or an unbroken run with no spaces at all) into either,
  // and without this it lays out on one line and widens every ancestor rather than
  // wrapping inside the field.
  // whitespace-pre-line: help text is authored as real prose with blank lines
  // between sections (see templates/content/acknowledgements.ts, whose policy text
  // carries its own headings). Collapsing those newlines ran the headings into the
  // sentence after them -- "...equivalent consequences. Professionalism Volunteers
  // are expected to..." -- which is what QA saw as headings "blending in with the
  // text". The source was already correct; only the rendering dropped the breaks.
  const help = f.helpText ? <span className="mt-1 block whitespace-pre-line break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{f.helpText}</span> : null;
  const err = fieldError ? <span id={errorId} role="alert" className="mt-1 block break-words text-xs text-critical-foreground [overflow-wrap:anywhere]">{fieldError}</span> : null;

  // Prefill for text-like inputs: a locked field is read-only (verified value);
  // otherwise it seeds an editable default. Read-only controlled inputs do not
  // trigger React warnings.
  const hasText = typeof prefill === "string";
  const textValue = prefillString(prefill);
  const textProps = !hasText ? {} : locked ? { value: textValue, readOnly: true } : { defaultValue: textValue };
  const lockedCls = hasText && locked ? "bg-muted text-muted-foreground" : null;

  // A NOTICE is content, not a question: it renders the authored heading/body as
  // a callout and (unless it asks to be acknowledged) contributes no control at
  // all. It comes before every other branch because none of the label/control
  // scaffolding below applies to it -- there is nothing to label.
  //
  // role="note" rather than Alert's default role="status": a notice is static
  // page content that is present on first paint, and a live region would have a
  // screen reader announce every policy paragraph again on any unrelated
  // re-render of the step.
  if (f.type === "NOTICE") {
    const ackLabel = noticeAcknowledgeLabel(f.validation);
    const heading = f.label.trim();
    const body = f.helpText?.trim() ?? "";
    return (
      <Alert tone="info" role="note">
        {heading && (
          <span className="block break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{heading}</span>
        )}
        {/* whitespace-pre-line for the same reason help text takes it: notices are
            authored as real prose with blank lines between paragraphs, and
            collapsing those runs the paragraphs together. linkifyUrls because a
            notice that points at a policy page is the common case and the stored
            string can never contain real markup. */}
        {body && (
          <span className={cx("block break-words whitespace-pre-line text-sm text-foreground-soft [overflow-wrap:anywhere]", heading && "mt-1")}>
            {linkifyUrls(body)}
          </span>
        )}
        {ackLabel && (
          <label className={cx("mt-2 flex min-h-[44px] items-start gap-2.5 py-1", disabled ? "cursor-default" : "cursor-pointer")}>
            <Checkbox name={f.key} required={required} disabled={disabled} {...errorAria} className="mt-0.5" defaultChecked={isPrefillChecked(prefill)} onChange={(e) => onValueChange?.(f.key, e.target.checked ? "on" : "")} />
            <span className="min-w-0 break-words text-sm text-foreground [overflow-wrap:anywhere]">{ackLabel}{req}</span>
          </label>
        )}
        {err}
      </Alert>
    );
  }

  if (f.type === "CHECKBOX") {
    return (
      <div>
        <label className={cx("flex min-h-[44px] items-start gap-2.5 py-1", disabled ? "cursor-default" : "cursor-pointer")}>
          <Checkbox name={f.key} required={required} disabled={disabled} {...errorAria} className="mt-0.5" defaultChecked={isPrefillChecked(prefill)} onChange={(e) => onValueChange?.(f.key, e.target.checked ? "on" : "")} />
          <span className="min-w-0 break-words text-sm text-foreground [overflow-wrap:anywhere]">{f.label}{req}</span>
        </label>
        {help}
        {err}
      </div>
    );
  }

  const onTextChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValueChange?.(f.key, e.target.value);
  const labelEl = <span className="block break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">{f.label}{req}</span>;
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
            // The native control renders "Choose File" and "No file chosen" as two
            // runs of identical plain text, so the part you click does not read as
            // clickable. Style ::file-selector-button to match the Button primitive
            // (bg-brand / white / rounded), which also separates the action from the
            // filename beside it.
            className="mt-1.5 cursor-pointer file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand file:px-3 file:py-1 file:text-sm file:font-medium file:text-white hover:file:bg-brand-hover"
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
            <label key={o.value} className={cx("flex min-h-[44px] items-center gap-2.5 break-words py-1 text-sm text-foreground [overflow-wrap:anywhere]", disabled ? "cursor-default" : "cursor-pointer")}>
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
        <legend className="block break-words p-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{f.label}{req}</legend>
        {help}{control}{err}
      </fieldset>
    );
  }
  return <label className="block min-w-0">{labelEl}{help}{control}{err}</label>;
}
