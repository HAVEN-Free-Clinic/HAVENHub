import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";

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
    <form action={action} className="space-y-3">
      <p className="text-sm text-slate-600">
        Departments this one manages. A director here also oversees these (one hop).
      </p>
      {candidates.length === 0 ? (
        <p className="text-sm text-slate-500">No other active departments to delegate to.</p>
      ) : (
        <div className="grid gap-1 sm:grid-cols-2">
          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <Checkbox name="managed" value={c.id} defaultChecked={selected.has(c.id)} />
              <span className="font-medium">{c.code}</span>
              <span className="text-slate-500">{c.name}</span>
            </label>
          ))}
        </div>
      )}
      <Button type="submit" variant="outline">Save delegations</Button>
    </form>
  );
}
