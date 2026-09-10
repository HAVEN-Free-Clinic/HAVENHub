import { Button } from "@/platform/ui/button";
import { Checkbox, CheckboxGroup } from "@/platform/ui/checkbox";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { EmptyState } from "@/platform/ui/empty-state";

type Candidate = { id: string; code: string; name: string };

/**
 * Checklist of departments a given (manager) department oversees. Checked = managed.
 * Submitting replaces the whole set via the passed server action.
 */
export function DelegationEditor({
  action,
  candidates,
  selectedIds,
}: {
  action: (formData: FormData) => Promise<void>;
  candidates: Candidate[];
  selectedIds: string[];
}) {
  const selected = new Set(selectedIds);
  return (
    <form action={action}>
      <Card className="space-y-3">
        <p className="text-sm text-foreground-soft">
          Departments this one manages. A director here also oversees these for compliance
          (one hop).
        </p>
        <p className="text-xs text-muted-foreground">
          Oversight only. This does not create a clinic service line or an attending roster,
          and does not grant scheduling rights over these departments.
        </p>
        {candidates.length === 0 ? (
          <EmptyState inline>No other active departments to delegate to.</EmptyState>
        ) : (
          // hideLegend: the two paragraphs above already carry the visible
          // meaning, but neither is associated with the checkboxes, so a screen
          // reader met an unnamed run of departments.
          <CheckboxGroup legend="Managed departments" hideLegend>
            <div className="grid gap-1 sm:grid-cols-2">
              {candidates.map((c) => (
                <Checkbox
                  key={c.id}
                  name="managed"
                  value={c.id}
                  defaultChecked={selected.has(c.id)}
                  label={
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{c.code}</span>
                      <span className="text-muted-foreground">{c.name}</span>
                    </span>
                  }
                />
              ))}
            </div>
          </CheckboxGroup>
        )}
        <FormActions>
          <Button type="submit" variant="outline">Save delegations</Button>
        </FormActions>
      </Card>
    </form>
  );
}
