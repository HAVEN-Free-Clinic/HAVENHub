import { ExternalLink, Stethoscope } from "lucide-react";
import { prisma } from "@/platform/db";
import { EPIC_APPS_URL } from "@/platform/external-links";

/**
 * Side-rail shortcut to the YNHH remote apps portal (Epic), shown only to
 * volunteers who have a provisioned Epic account (Person.epicId). Its own async
 * Server Component so a DB hiccup degrades to rendering nothing rather than
 * taking down the dashboard: this card is optional, so a render-path read
 * failure must never throw.
 */
export async function EpicAccessCard({ personId }: { personId: string }) {
  let epicId: string | null = null;
  try {
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { epicId: true },
    });
    epicId = person?.epicId ?? null;
  } catch {
    return null;
  }
  if (!epicId) return null;

  return (
    <a
      href={EPIC_APPS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-2xl border border-brand/20 bg-brand-faint p-4 transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand/15 bg-surface text-brand-fg">
        <Stethoscope aria-hidden className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-bold uppercase tracking-wider text-brand-fg">
          Access Epic
        </span>
        <span className="mt-0.5 block truncate text-sm font-medium text-foreground-soft">
          YNHH Remote Access
        </span>
        <span className="sr-only"> (opens in a new tab)</span>
      </span>
      <ExternalLink aria-hidden className="ml-auto h-4 w-4 shrink-0 text-brand-fg" />
    </a>
  );
}
