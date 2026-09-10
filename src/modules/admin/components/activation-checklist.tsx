import Link from "next/link";
import { Alert } from "@/platform/ui/alert";
import type { ActivationReadiness } from "@/modules/admin/services/term-readiness";
import { activationChecklistItems } from "./activation-checklist-items";

/**
 * What activating this term will change, shown above the Activate button.
 * Informational: it never disables the button. The sentences live in
 * activationChecklistItems so they can be tested without rendering.
 */
export function ActivationChecklist({
  readiness,
  incoming,
  stepLabels,
}: {
  readiness: ActivationReadiness;
  incoming: { id: string; code: string };
  stepLabels: Partial<Record<string, string>>;
}) {
  const items = activationChecklistItems(readiness, incoming, stepLabels);
  return (
    <div className="mb-4 space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Before you activate</h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.key}>
            <Alert tone={item.tone}>
              {item.text}
              {item.link && (
                <>
                  {" "}
                  <Link href={item.link.href} className="underline hover:text-foreground">
                    {item.link.label}
                  </Link>
                </>
              )}
            </Alert>
          </li>
        ))}
      </ul>
    </div>
  );
}
