import Link from "next/link";
import { Card } from "@/platform/ui/card";
import { DateOnly } from "@/platform/dates/display";
import { can } from "@/platform/rbac/engine";
import {
  PROVISIONAL_PERMISSION,
  provisionalEndingSoon,
} from "@/platform/ehs/services/provisional";

/**
 * Reminder box for Platform Admins: provisional EHS clearances ending in the
 * next two days that EHS has not confirmed. Renders nothing for anyone else, or
 * when there is nothing to chase.
 */
export async function ProvisionalEndingSoon({ viewerPersonId }: { viewerPersonId: string }) {
  if (!(await can(viewerPersonId, PROVISIONAL_PERMISSION))) return null;
  const rows = await provisionalEndingSoon();
  if (rows.length === 0) return null;

  return (
    <div className="mb-6">
      <Card>
        <p className="text-sm font-medium text-warning-foreground">
          Provisional clearances ending soon
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/volunteers/compliance/${r.personId}`} className="text-brand hover:underline">
                {r.personName}
              </Link>
              {" · "}
              {r.trainingName}
              {" · ends "}
              <DateOnly value={r.expiresAt} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}