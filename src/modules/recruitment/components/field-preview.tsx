import { Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";

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
  f, departments, fieldError, onDeptChoice, disabled = false,
}: {
  f: PreviewFieldDef;
  departments: string[];
  fieldError?: string;
  onDeptChoice?: (v: string) => void;
  disabled?: boolean;
}) {
  const required = f.required;
  const invalid = fieldError ? true : undefined;
  const req = required ? <span className="text-critical"> *</span> : null;
  const help = f.helpText ? <span className="mt-1 block text-xs text-muted-foreground">{f.helpText}</span> : null;
  const err = fieldError ? <span className="mt-1 block text-xs text-critical">{fieldError}</span> : null;

  // A single boolean checkbox reads as a statement you agree to, so the box sits
  // inline with its label rather than orphaned under a heading. The tap row is a
  // full 44px target. This shape is shared by the public form and the builder.
  if (f.type === "CHECKBOX") {
    return (
      <div>
        <label className={cx("flex min-h-[44px] items-start gap-2.5 py-1", disabled ? "cursor-default" : "cursor-pointer")}>
          <Checkbox name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-0.5" />
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
    case "LONG_TEXT": control = <Textarea name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" rows={4} />; break;
    case "NUMBER": control = <Input type="number" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" />; break;
    case "DATE": control = <Input type="date" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" />; break;
    case "EMAIL": control = <Input type="email" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" />; break;
    case "PHONE": control = <Input type="tel" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" />; break;
    case "FILE": {
      const accept = Array.isArray(f.validation?.acceptedTypes) ? (f.validation!.acceptedTypes as string[]).join(",") : undefined;
      control = <Input type="file" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} accept={accept} className="mt-1.5 cursor-pointer" />;
      break;
    }
    case "DEPARTMENT_CHOICE":
      control = <Select name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" onChange={(e) => onDeptChoice?.(e.target.value)} defaultValue=""><option value="" disabled>Select…</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>;
      break;
    case "SINGLE_SELECT":
      control = <Select name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" defaultValue=""><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
      break;
    case "MULTI_SELECT":
      control = (
        <span className="mt-1 flex flex-col">
          {(f.options ?? []).map((o) => (
            <label key={o.value} className={cx("flex min-h-[44px] items-center gap-2.5 py-1 text-sm text-foreground", disabled ? "cursor-default" : "cursor-pointer")}>
              <Checkbox name={f.key} value={o.value} disabled={disabled} /> {o.label}
            </label>
          ))}
        </span>
      );
      break;
    default: control = <Input type="text" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" />;
  }
  return <label className="block">{labelEl}{help}{control}{err}</label>;
}
