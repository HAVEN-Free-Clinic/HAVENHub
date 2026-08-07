import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { getSetting } from "@/platform/settings/service";
import { getCredentialByToken } from "@/modules/passport/services/credential";
import { formatShifts } from "@/modules/passport/components/passport-pdf";

export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated verification page for a member's service record.
 *
 * Deliberately outside the (app) route group so it never inherits
 * requirePersonSession or the onboarding gate. Rendered from the SNAPSHOT, never
 * a live computation, so this URL can only ever show what the member published.
 */
export async function generateMetadata(): Promise<Metadata> {
  const base = await buildPageMetadata({
    title: "Record of Service",
    description: "A verified record of clinic service.",
  });
  // Never indexed: this page carries a real person's name and affiliation.
  // buildPageMetadata returns a plain object literal with no robots key of its
  // own (and no parent layout sets one either), so spreading it here and adding
  // robots is not overwritten by anything upstream.
  return { ...base, robots: { index: false, follow: false } };
}

export default async function CredentialPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const credential = await getCredentialByToken(token);
  if (!credential) notFound();

  const orgName = await getSetting<string>("branding.orgName");
  const { record } = credential;
  const issued = new Date(credential.issuedAt).toISOString().slice(0, 10);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {orgName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold">Record of Service</h1>

      <p className="mt-8 text-lg">{record.name}</p>
      {record.memberSince ? (
        <p className="text-sm text-muted-foreground">Member since {record.memberSince.label}</p>
      ) : null}

      <h2 className="mt-10 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Service history
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-strong text-left">
              <th className="py-2 font-normal">Term</th>
              <th className="py-2 font-normal">Department</th>
              <th className="py-2 font-normal">Role</th>
              <th className="py-2 text-right font-normal">Clinic shifts</th>
            </tr>
          </thead>
          <tbody>
            {record.terms.map((row) => (
              <tr key={`${row.source}-${row.termCode}`} className="border-b border-border-subtle">
                <td className="py-2">
                  {row.termName}
                  {row.source === "RECRUITMENT" ? (
                    <span className="block text-xs text-muted-foreground">Joined via recruitment</span>
                  ) : null}
                </td>
                <td className="py-2">{row.departmentName}</td>
                <td className="py-2">{row.track === "DIRECTOR" ? "Director" : "Volunteer"}</td>
                <td className="py-2 text-right">{formatShifts(row.shifts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-10 text-xs leading-relaxed text-muted-foreground">
        Clinic shift counts reflect published schedule assignments, not attendance. Terms marked
        &quot;Not recorded&quot; predate {orgName}&apos;s scheduling records. Issued {issued} by{" "}
        {orgName}.
      </p>
    </main>
  );
}
