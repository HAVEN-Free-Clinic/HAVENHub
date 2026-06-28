import { Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { asPrefillList, isPrefillChecked, prefillString } from "./field-prefill";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

export type PreviewFieldDef = {
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  required: boolean;
  options: { value: string; label: string }[] | null;
  validation: Record<string, unknown> | null;
};

export function FieldPreview({
  f, departments, subcommittees = [], fieldError, onDeptChoice, disabled = false, prefill, locked = false,
}: {
  f: PreviewFieldDef;
  departments: string[];
  subcommittees?: { id: string; name: string }[];
  fieldError?: string;
  onDeptChoice?: (v: string) => void;
  disabled?: boolean;
  // A draft/renewal answer: string (text, single-select), string[] (multi-select,
  // subcommittee rank), or a file-reference object. Narrowed per control below.
  prefill?: unknown;
  locked?: boolean;
}) {
  const required = f.required;
  const invalid = fieldError ? true : undefined;
  const req = required ? <span className="text-critical"> *</span> : null;
  const help = f.helpText ? <span className="mt-1 block text-xs text-muted-foreground">{f.helpText}</span> : null;
  const err = fieldError ? <span className="mt-1 block text-xs text-critical">{fieldError}</span> : null;

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
          <Checkbox name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-0.5" defaultChecked={isPrefillChecked(prefill)} />
          <span className="text-sm text-foreground">{f.label}{req}</span>
        </label>
        {help}
        {err}
      </div>
    );
  }

  const labelEl = <span className="block text-sm font-medium text-foreground">{f.label}{req}</span>;
  let control: React.ReactNode;
  switch (f.type) {
    case "LONG_TEXT": control = <Textarea name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} rows={4} {...textProps} />; break;
    case "NUMBER": control = <Input type="number" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "DATE": control = <Input type="date" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "EMAIL": control = <Input type="email" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "PHONE": control = <Input type="tel" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "FILE": {
      const accept = Array.isArray(f.validation?.acceptedTypes) ? (f.validation!.acceptedTypes as string[]).join(",") : undefined;
      control = <Input type="file" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} accept={accept} className="mt-1.5 cursor-pointer" />;
      break;
    }
    case "DEPARTMENT_CHOICE":
      control = <Select name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" onChange={(e) => onDeptChoice?.(e.target.value)} defaultValue={prefillString(prefill)}><option value="" disabled>Select…</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>;
      break;
    case "SINGLE_SELECT":
      control = <Select name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" defaultValue={prefillString(prefill)}><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
      break;
    case "MULTI_SELECT": {
      const selected = new Set(asPrefillList(prefill));
      control = (
        <span className="mt-1 flex flex-col">
          {(f.options ?? []).map((o) => (
            <label key={o.value} className={cx("flex min-h-[44px] items-center gap-2.5 py-1 text-sm text-foreground", disabled ? "cursor-default" : "cursor-pointer")}>
              <Checkbox name={f.key} value={o.value} disabled={disabled} defaultChecked={selected.has(o.value)} /> {o.label}
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
      control = (
        <span className="mt-1 flex flex-col gap-2">
          {Array.from({ length: rankCount }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{ordinals[i] ?? `Choice ${i + 1}`}</span>
              <Select name={f.key} required={f.required && i === 0} disabled={disabled} defaultValue={ranks[i] ?? ""} className="flex-1">
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
    default: control = <Input type="text" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />;
  }
  return <label className="block">{labelEl}{help}{control}{err}</label>;
}
