/**
 * The member's own language capabilities, on /my-info.
 *
 * Shows all three states rather than only the confirmed ones, because the two
 * unconfirmed states are the ones a member would otherwise have no way to see:
 *
 *   - awaiting review  -> they claimed it, nobody has assessed it yet
 *   - confirmed        -> on record, directors can schedule them for it
 *   - not confirmed    -> assessed and declined; they are NOT on record
 *
 * Hiding the last two would leave someone believing a claim they made on their
 * application had made them a language provider when it had not.
 *
 * Lives in the app layer, not src/modules/my-info, because eslint forbids one
 * module importing another and the data comes from the platform languages
 * service. Purely presentational.
 */

import type { PersonLanguage } from "@prisma/client";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { languageLabel } from "@/platform/languages";

export function LanguagesPanel({ languages }: { languages: PersonLanguage[] }) {
  if (languages.length === 0) {
    return (
      <Card>
        <p className="text-sm text-subtle-foreground">
          You have not told us about any languages other than English. You can add them on your
          next application, or ask the interpreting department to record one.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <ul className="space-y-3">
        {languages.map((l) => {
          const assessed = l.verifiedAt !== null;
          return (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{languageLabel(l.language)}</span>
              {!assessed ? (
                <Badge tone="warning">Awaiting review</Badge>
              ) : l.verified ? (
                <Badge tone="success">Confirmed</Badge>
              ) : (
                <Badge tone="default">Not confirmed</Badge>
              )}
              {l.note && (
                <span className="w-full text-xs text-subtle-foreground">{l.note}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-xs text-subtle-foreground">
        Only a confirmed language puts you on record as a provider for it. The interpreting
        department confirms each one before you are scheduled in that role.
      </p>
    </Card>
  );
}
