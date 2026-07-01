import { Card } from "@/platform/ui/card";
import type { MyEhsItem } from "@/modules/ehs/services/my-ehs";
import { fmtDate } from "@/platform/dates";

export function EhsPanel({ items }: { items: MyEhsItem[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-sm text-subtle-foreground">
          No EHS trainings are required for you.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-2">
              {item.complete ? (
                <span className="text-success-foreground font-medium">Done</span>
              ) : (
                <span className="text-subtle-foreground">Needed</span>
              )}
              <span>{item.name}</span>
            </span>
            {item.complete && item.completedAt && (
              <span className="shrink-0 text-xs text-subtle-foreground">
                completed {fmtDate(item.completedAt)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
