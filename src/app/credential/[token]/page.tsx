import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { getSetting } from "@/platform/settings/service";
import { getCredentialByToken } from "@/modules/passport/services/credential";
import { formatShiftsAndHours, formatServiceDates, trackLabel } from "@/modules/passport/services/service-record";
import { THead, TR, TH, TD } from "@/platform/ui/table";
import { CopyrightNotice } from "@/platform/ui/app-footer";

export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated verification page for a member's service record.
 *
 * Deliberately outside the (app) route group so it never inherits
 * requirePersonSession or the onboarding gate. Rendered from the SNAPSHOT, never
 * a live computation, so this URL can only ever show what the member published.
 *
 * The photo is the one exception: photoKey/photoVersion come from the LIVE
 * person relation on credential, not from the frozen record, so a member who
 * removes their photo stops seeing it here immediately instead of it lingering
 * in a snapshot for the life of the credential.
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

      {credential.person.photoKey ? (
        <img
          src={`/credential/${token}/photo?v=${credential.person.photoVersion}`}
          alt={record.name}
          width={128}
          height={128}
          className="mt-8 rounded-full object-cover"
        />
      ) : null}

      <p className="mt-8 text-lg">{record.name}</p>
      {record.memberSince ? (
        <p className="text-sm text-muted-foreground">Member since {record.memberSince.label}</p>
      ) : null}

      <h2 className="mt-10 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Service history
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <THead>
            <TR>
              <TH>Term</TH>
              <TH>Department</TH>
              <TH>Role</TH>
              <TH className="text-right">Clinic shifts</TH>
            </TR>
          </THead>
          <tbody>
            {record.terms.map((row) => (
              // Department is part of the key: a member in two departments in
              // one term produces two rows with the same source and term code.
              <TR key={`${row.source}-${row.termCode}-${row.departmentName}`}>
                <TD>
                  {row.termName}
                  {row.source === "RECRUITMENT" ? (
                    <span className="block text-xs text-muted-foreground">Joined via recruitment</span>
                  ) : null}
                </TD>
                <TD>{row.departmentName}</TD>
                <TD>{trackLabel(row.track)}</TD>
                <TD className="text-right">
                  {formatShiftsAndHours(row.shifts, row.hours)}
                  {/* Dates on their own line: they are long, and the cell above
                      is the summary a reader scans first. Empty string when
                      unknown, so the line disappears rather than needing a
                      placeholder. */}
                  {formatServiceDates(row.dates) && (
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {formatServiceDates(row.dates)}
                    </span>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-10 text-xs leading-relaxed text-muted-foreground">
        Clinic shift counts reflect published schedule assignments, not attendance. Terms marked
        &quot;Not recorded&quot; predate {orgName}&apos;s scheduling records. Issued {issued} by{" "}
        {orgName}.
      </p>
      <CopyrightNotice className="mt-6" />
    </main>
  );
}
