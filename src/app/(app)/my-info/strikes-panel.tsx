/**
 * A member's own disciplinary record, on /my-info.
 *
 * Before this existed, a strike was emailed to its subject once and then lived
 * only in a ledger they could not open: a volunteer asking "how many strikes do
 * I have?" had to ask a director. Under a three-strikes policy that is the one
 * number they most need, so it is shown here rather than left to memory.
 *
 * Lives in the app layer, not src/modules/my-info, because eslint forbids one
 * module importing another and the data comes from the incidents module. The
 * /my-info page already composes across modules this way (onboarding, passport).
 *
 * Purely presentational. Redaction of what the subject may read happens upstream
 * in subjectFacingDetail (disciplinary.ts), shared with the strike_issued email.
 */

import type { MyStrike } from "@/modules/incidents/services/disciplinary";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { formatCalendarDate } from "@/platform/dates";

/** Ordinal words for the counts a three-strikes policy actually reaches. */
const ORDINAL_LABEL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd" };
function ordinalLabel(n: number): string {
  return ORDINAL_LABEL[n] ?? `${n}th`;
}

export function StrikesPanel({ strikes }: { strikes: MyStrike[] }) {
  // A clean record is worth stating outright. Rendering nothing would leave a
  // member unsure whether they have no strikes or the page failed to load.
  if (strikes.length === 0) {
    return (
      <Card>
        <p className="text-sm text-subtle-foreground">
          You have no disciplinary actions on file.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <p className="text-sm text-foreground-soft">
        You have <strong className="text-foreground">{strikes.length}</strong>{" "}
        {strikes.length === 1 ? "strike" : "strikes"} on file.
      </p>
      <ul className="mt-4 space-y-4">
        {strikes.map((s) => (
          <li key={s.id} className="border-t border-border-subtle pt-4 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{ordinalLabel(s.ordinal)} strike</Badge>
              <span className="text-sm font-medium text-foreground">{s.category}</span>
              {/* formatCalendarDate, NOT DateOnly: occurredAt is a calendar-day
                  marker anchored at UTC, so zone-shifting it would show an ET
                  member a strike dated a day earlier than the ledger their
                  director reads and the email they were sent. Matches how the
                  ledger (incidents/strikes/page.tsx) and strike-notifications
                  both format the same field. */}
              <span className="text-xs text-subtle-foreground">
                {formatCalendarDate(s.occurredAt, { month: "long", day: "numeric", year: "numeric" })}
              </span>
            </div>
            {s.detail && (
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground-soft">{s.detail}</p>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-subtle-foreground">
        Questions about a disciplinary action go to your department directors or the Executive Directors.
      </p>
    </Card>
  );
}
