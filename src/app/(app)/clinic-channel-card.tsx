import { ExternalLink, MessagesSquare } from "lucide-react";
import { getCurrentClinicChannelLink } from "@/platform/teams/channel-link";

/**
 * Side-rail link to this week's clinic Teams channel. Isolated as its own async
 * Server Component because getCurrentClinicChannelLink() makes an external
 * Microsoft Graph call that can take several seconds. Rendered inside a
 * <Suspense> on the hub so it streams in independently -- the rest of the
 * dashboard never blocks on Graph. Renders nothing when there is no channel
 * (unconfigured, not connected, or no current clinic week).
 */
export async function ClinicChannelCard() {
  const clinicChannel = await getCurrentClinicChannelLink();
  if (!clinicChannel) return null;

  return (
    <a
      href={clinicChannel.webUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-2xl border border-brand/20 bg-brand-faint p-4 transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand/15 bg-surface text-brand-fg">
        <MessagesSquare aria-hidden className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-bold uppercase tracking-wider text-brand-fg">
          This week&apos;s clinic
        </span>
        <span className="mt-0.5 block truncate text-sm font-medium text-foreground-soft">
          {clinicChannel.displayName}
        </span>
        <span className="sr-only"> (opens in a new tab)</span>
      </span>
      <ExternalLink aria-hidden className="ml-auto h-4 w-4 shrink-0 text-brand-fg" />
    </a>
  );
}
