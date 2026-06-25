import { Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";

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
  const label = <span className="block text-sm font-medium">{f.label}{f.required && <span className="text-critical"> *</span>}</span>;
  const help = f.helpText ? <span className="block text-xs text-muted-foreground">{f.helpText}</span> : null;
  const err = fieldError ? <span className="block text-xs text-critical">{fieldError}</span> : null;
  let control: React.ReactNode;
  switch (f.type) {
    case "LONG_TEXT": control = <Textarea name={f.key} required={f.required} disabled={disabled} className="mt-1" rows={4} />; break;
    case "CHECKBOX": control = <input type="checkbox" name={f.key} disabled={disabled} />; break;
    case "NUMBER": control = <Input type="number" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "DATE": control = <Input type="date" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "EMAIL": control = <Input type="email" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "PHONE": control = <Input type="tel" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "FILE": {
      const accept = Array.isArray(f.validation?.acceptedTypes) ? (f.validation!.acceptedTypes as string[]).join(",") : undefined;
      control = <Input type="file" name={f.key} required={f.required} disabled={disabled} accept={accept} className="mt-1 cursor-pointer" />;
      break;
    }
    case "DEPARTMENT_CHOICE":
      control = <Select name={f.key} required={f.required} disabled={disabled} className="mt-1" onChange={(e) => onDeptChoice?.(e.target.value)} defaultValue=""><option value="" disabled>Select…</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>;
      break;
    case "SINGLE_SELECT":
      control = <Select name={f.key} required={f.required} disabled={disabled} className="mt-1" defaultValue=""><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
      break;
    case "MULTI_SELECT":
      control = <span className="mt-1 flex flex-col gap-1">{(f.options ?? []).map((o) => <label key={o.value} className="text-sm"><input type="checkbox" name={f.key} value={o.value} disabled={disabled} /> {o.label}</label>)}</span>;
      break;
    default: control = <Input type="text" name={f.key} required={f.required} disabled={disabled} className="mt-1" />;
  }
  return <label className="block">{label}{help}{control}{err}</label>;
}
