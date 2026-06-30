import Link from "next/link";
import { getOrgIdentity, formatOrgLine } from "@/platform/branding/org";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";

export default async function NotFound() {
  const [org, support] = await Promise.all([getOrgIdentity(), getSupportContact()]);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-muted p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 shadow-sm">
        <HavenLogo className="h-8 text-brand-fg" />
        <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
          Error 404
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-soft">
          That page doesn&apos;t exist, or it may have moved. If you followed a
          link from inside the clinic, let{" "}
          <SupportLink email={support.email}>the IT team</SupportLink> know so we
          can fix it.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
        >
          Back to Hub
        </Link>
      </div>
      <p className="mt-6 text-xs text-subtle-foreground">{formatOrgLine(org)}</p>
    </main>
  );
}
