import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import type { WizardField } from "./wizard-steps";

export type ReviewRow = { label: string; value: string; imageSrc?: string };
export type ReviewGroup = { stepIndex: number; title: string; rows: ReviewRow[] };

/** Human-readable display of a submitted answer, by field type. Values come from
 *  the form's FormData (string or string[]); FILE values are a pre-resolved file
 *  name string. Empty answers return "" (the component shows "Not provided"). */
export function formatFieldValue(
  f: WizardField,
  values: Record<string, unknown>,
  subcommittees: { id: string; name: string }[],
): string {
  const raw = values[f.key];
  const list = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  const one = typeof raw === "string" ? raw : "";
  switch (f.type) {
    case "CHECKBOX":
      return raw === "on" || raw === true ? "Yes" : "No";
    case "SINGLE_SELECT":
    case "DEPARTMENT_CHOICE":
      return f.options?.find((o) => o.value === one)?.label ?? one;
    case "MULTI_SELECT":
      return list.map((v) => f.options?.find((o) => o.value === v)?.label ?? v).join(", ");
    case "SUBCOMMITTEE_RANK":
      return list
        .filter((v) => v !== "")
        .map((id) => subcommittees.find((s) => s.id === id)?.name ?? id)
        .join(" › ");
    case "FILE":
      return one || "Not attached";
    case "SIGNATURE":
      return one ? "Signed" : "";
    default:
      return one;
  }
}

export function WizardReview({
  groups,
  onEdit,
}: {
  groups: ReviewGroup[];
  onEdit: (stepIndex: number) => void;
}) {
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <Card key={g.stepIndex} className="space-y-3">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
            <h3 className="text-sm font-semibold text-foreground">{g.title}</h3>
            {/* eslint-disable-next-line no-restricted-syntax -- token-styled avoids primitive className override */}
            <button type="button" onClick={() => onEdit(g.stepIndex)} aria-label={`Edit ${g.title}`} className="-my-2 inline-flex min-h-[44px] items-center rounded-md px-2 text-xs font-medium text-brand-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
              Edit
            </button>
          </div>
          <dl className="space-y-2">
            {g.rows.map((r) => (
              <div key={r.label} className="grid gap-1 sm:grid-cols-[180px_1fr] sm:gap-4">
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="text-sm text-foreground">
                  {r.imageSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element -- inline signature data URL, not a remote asset
                    <img src={r.imageSrc} alt={`${r.label} signature`} className="h-16 rounded border border-border-subtle bg-surface" />
                  ) : (
                    r.value || <span className="italic text-subtle-foreground">Not provided</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
      <Alert tone="info">
        Please confirm the information above is accurate. After you submit, you will get a confirmation
        email and can track your application here in the portal.
      </Alert>
    </div>
  );
}
