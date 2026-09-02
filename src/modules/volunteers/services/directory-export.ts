/**
 * CSV export of the people directory: the contact list an Executive Director
 * pulls to mail a department, a role, or the whole clinic.
 *
 * This is the widest bulk PII egress in the app -- name, NetID, Yale address,
 * contact address and phone for every person matching a filter, in one file.
 * Two consequences that are not optional:
 *
 *   1. The route audits every call (see the export route), the same way the
 *      offboarding export does for the same reason.
 *   2. Every row goes through toCsv's neutralizeFormulas. Person.name and
 *      Person.contactEmail are user-supplied -- the apply wizard takes names
 *      from anonymous applicants and /my-info lets members edit their own
 *      record -- and a field starting with "=" opens as a live formula in
 *      Excel and Google Sheets.
 *
 * Both scopes reuse the directory service's own selectors, so a download is
 * always exactly the rows the screen was showing. `now` is a parameter rather
 * than a call to the clock so the filename is deterministic in tests.
 *
 * Trusts its caller for permissions: the route gates on volunteers.view_directory.
 */

import { toCsv } from "@/platform/csv";
import { accountEmailForPerson } from "@/platform/auth/match-person";
import {
  directoryPeopleAll,
  directoryAttendings,
  type DirectoryFilters,
  type DirectoryScope,
} from "./directory";

export type DirectoryExportRequest =
  | ({ scope: "people" } & DirectoryFilters)
  | { scope: "attendings" };

const PEOPLE_HEADERS = [
  "Name",
  "Email",
  "NetID",
  "Contact email",
  "Phone",
  "Departments",
  "Role",
];

const ATTENDING_HEADERS = ["Name", "Credentials", "Specialty", "Email", "Phone"];

/**
 * One row per PERSON, not per seat: a mailing list must not contain the same
 * address twice because its owner sits in two departments. Someone in Nursing
 * and Triage is one row whose Departments cell reads "NURS;TRIA".
 *
 * Role collapses the same way, and DIRECTOR wins a tie. Someone who directs one
 * department and volunteers in another is a director for the purpose of a list
 * you are about to mail -- the same rule the offboarding export uses.
 *
 * Reads `seats` (the seats that matched the filters) and not `otherSeats`, so a
 * directors-only pull never labels a row VOLUNTEER and a Nursing pull describes
 * the Nursing slice. The screen shows the unmatched seats as an "also" line
 * because a reader is looking at one person at a time; a mailing list is not,
 * and its Departments column names the slice being mailed. The row SET is
 * identical either way, which is the invariant that matters.
 */
function peopleRows(
  people: Awaited<ReturnType<typeof directoryPeopleAll>>,
): string[][] {
  return people.map((p) => {
    const codes = [...new Set(p.seats.map((s) => s.departmentCode))].sort();
    const role = p.seats.some((s) => s.kind === "DIRECTOR") ? "DIRECTOR" : "VOLUNTEER";
    return [
      p.name,
      accountEmailForPerson(p),
      p.netId ?? "",
      p.contactEmail ?? "",
      p.phone ?? "",
      codes.join(";"),
      role,
    ];
  });
}

/**
 * Names the file after what is actually in it, so three downloads in a row do
 * not land in ~/Downloads as the same name with (1) and (2) appended and leave
 * the reader guessing which was the directors-only pull.
 */
function peopleFilename(
  termCode: string,
  filters: DirectoryFilters,
  departmentCode: string | null,
  day: string,
): string {
  const parts = ["haven-directory", termCode.toLowerCase()];
  if (departmentCode) parts.push(departmentCode.toLowerCase());
  if (filters.kind) parts.push(filters.kind.toLowerCase() + "s");
  parts.push(day);
  return `${parts.join("-")}.csv`;
}

/**
 * `viewerScope` is the departments the CALLER may see (null = clinic-wide),
 * distinct from `input.scope`, which is the half of the page being exported.
 * Both go through the directory service's own selectors, so a scoped director's
 * download is exactly the rows their screen was showing -- an export that
 * outran the view would be the leak this whole scope exists to prevent.
 */
export async function buildDirectoryCsv(
  input: DirectoryExportRequest,
  viewerScope: DirectoryScope,
  ctx: { termId: string | null; termCode: string | null; departmentCode: string | null },
  now: Date,
): Promise<{ filename: string; csv: string; rowCount: number }> {
  const day = now.toISOString().slice(0, 10);

  if (input.scope === "attendings") {
    const attendings = await directoryAttendings(viewerScope);
    const rows = attendings.map((a) => [
      a.fullName,
      a.credentials ?? "",
      a.specialty ?? "",
      a.email ?? "",
      a.phone ?? "",
    ]);
    return {
      filename: `haven-attendings-${day}.csv`,
      csv: toCsv(ATTENDING_HEADERS, rows, { neutralizeFormulas: true }),
      rowCount: rows.length,
    };
  }

  const { scope: _scope, ...filters } = input;
  const people = await directoryPeopleAll(ctx.termId, filters, viewerScope);
  const rows = peopleRows(people);
  return {
    // No active term means no roster to export. The header row still ships, so
    // the download opens as an empty list rather than a broken file.
    filename: peopleFilename(ctx.termCode ?? "no-term", filters, ctx.departmentCode, day),
    csv: toCsv(PEOPLE_HEADERS, rows, { neutralizeFormulas: true }),
    rowCount: rows.length,
  };
}
