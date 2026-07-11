import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import type { WizardField } from "./wizard-steps";

export type ReviewRow = { label: string; value: string };
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
        <Card key={g.title} className="space-y-3">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
            <h3 className="text-sm font-semibold text-foreground">{g.title}</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onEdit(g.stepIndex)}
              className="text-brand-fg hover:underline"
            >
              Edit
            </Button>
          </div>
          <dl className="space-y-2">
            {g.rows.map((r) => (
              <div key={r.label} className="grid gap-1 sm:grid-cols-[180px_1fr] sm:gap-4">
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="text-sm text-foreground">
                  {r.value || <span className="italic text-subtle-foreground">Not provided</span>}
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
