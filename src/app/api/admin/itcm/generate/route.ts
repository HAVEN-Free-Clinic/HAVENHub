/**
 * POST /api/admin/itcm/generate
 *
 * Generates a filled YNHH Electronic Service Request PDF for one of five
 * Epic access request scenarios, plus an Excel spreadsheet for bulk requests.
 * Returns base64-encoded file payloads and a pre-written email body so the
 * client can trigger downloads and show the draft without a second round-trip.
 *
 * The PDF template lives at public/templates/epic-request-template.pdf. It must
 * be committed to the repo; this route reads it at runtime via the filesystem.
 *
 * Mirror person logic: finds another ACTIVE member in the same department
 * with the same role who already has an epicId. Directors mirror directors,
 * volunteers mirror volunteers.
 *
 * Auth: signed-in person with the "admin.access" permission — only platform
 * admins and ITCM directors reach this route.
 */

import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { findMirrorPerson, getPeopleByIds, listEpicAuthorizers, reconcileDeactivationRequests } from "@/modules/admin/services/itcm";
import {
  generatePdf,
  type RequestType,
} from "@/modules/admin/services/itcm-pdf";
import { prisma } from "@/platform/db";



// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMAIL_BODIES: Record<RequestType, (args: {
  personName: string;
  epicId: string;
  endDate: string;
  authorizerName: string;
  userCount: number;
}) => string> = {
  new_individual: ({ personName, endDate, authorizerName }) =>
    `Hello,\nI hope you are doing well. Could we please create a new Epic account for ${personName} in the department "YM HAVEN FREE CLINIC" until ${endDate}?\n\n- They will need the abilities identical to the Epic ID listed under "Epic ID to Mirror", in the department YM HAVEN FREE CLINIC\n- They neither have YNHH hospital privileges nor are requesting them.\n- They will complete Epic training upon receipt of their accounts.\n\nI've attached the completed pdf request form with further details. Please feel free to contact me with any questions or if you need any more information.\n\nBest,\n${authorizerName}`,
  mod_individual: ({ personName, epicId, authorizerName }) =>
    `Hello,\nCould we please modify Epic access for the user ${personName} (Epic ID: ${epicId})? They will need the abilities of the corresponding Epic ID to mirror included in the request PDF in the department YM HAVEN FREE CLINIC.\n\nPlease feel free to contact me with any questions or if you need any more information.\n\nBest,\n${authorizerName}`,
  renew_individual: ({ personName, epicId, authorizerName }) =>
    `Hello,\nCould we renew Epic access for the user ${personName} (Epic ID: ${epicId})? They will need the abilities of the corresponding Epic ID to mirror included in the request PDF in the department YM HAVEN FREE CLINIC.\n\nPlease feel free to contact me with any questions or if you need any more information.\n\nBest,\n${authorizerName}`,
  bulk_mod: ({ endDate, authorizerName, userCount }) =>
    `Hello,\nCould we please reactivate/extend the Epic accounts for the users in the Excel Spreadsheet?\nThey already have an Epic account, but need access to the department "YM HAVEN FREE CLINIC".\nPlease reactivate and/or extend their access until ${endDate}.\nThey will need the abilities of the corresponding Epic ID to mirror (included in the spreadsheet), in the department YM HAVEN FREE CLINIC.\nThey neither have YNHH privileges nor are requesting them.\nI've attached a spreadsheet containing ${userCount} users and the completed pdf request form. Please feel free to contact me with any questions or if you require more information. Thank you very much!\n\nBest,\n${authorizerName}`,
  bulk_new: ({ authorizerName, userCount }) =>
    `Hello,\nI hope you are doing well! Could we please create new Epic accounts for each of the attached users in the department "YM HAVEN FREE CLINIC"?\nThey will need the abilities identical to the Epic ID listed under "Epic ID to Mirror," in the department YM HAVEN FREE CLINIC\nThese individuals neither have YNHH hospital privileges nor are requesting them.\nThey will complete Epic training upon receipt of their accounts.\nI've attached the completed pdf request form with further details and an Excel spreadsheet with a set of ${userCount} users who need access. Please feel free to contact me with any questions or if you need any more information. Thank you!\n\nBest,\n${authorizerName}`,
  deactivate_individual: ({ personName, endDate, authorizerName }) =>
    `Hello,\nCould we please DEACTIVATE Epic access for ${personName}? They are no longer with the YM HAVEN FREE CLINIC. Please deactivate their access effective ${endDate}.\nThe completed PDF request form is attached. Please contact me with any questions.\n\nBest,\n${authorizerName}`,
  bulk_deactivate: ({ endDate, authorizerName, userCount }) =>
    `Hello,\nCould we please DEACTIVATE Epic access for the ${userCount} users in the attached spreadsheet? They are no longer with the YM HAVEN FREE CLINIC. Please deactivate their access effective ${endDate}.\nThe completed PDF request form and the spreadsheet are attached. Please contact me with any questions.\n\nBest,\n${authorizerName}`,
};

const PDF_FILENAMES: Record<RequestType, (initials: string, date: string) => string> = {
  new_individual: (i, d) => `${i} ${d} NEW Service Request Form_V5.5.pdf`,
  mod_individual: (i, d) => `${i} ${d} MOD_REACT Service Request Form_V5.5.pdf`,
  renew_individual: (i, d) => `${i} ${d} MOD_REACT Service Request Form_V5.5.pdf`,
  bulk_new: (i, d) => `${i} ${d} Multiple Users NEW Service Request Form_V5.5.pdf`,
  bulk_mod: (i, d) => `${i} ${d} Multiple Users MOD_REACT Service Request Form_V5.5.pdf`,
  deactivate_individual: (i, d) => `${i} ${d} DEACTIVATE Service Request Form_V5.5.pdf`,
  bulk_deactivate: (i, d) => `${i} ${d} Multiple Users DEACTIVATE Service Request Form_V5.5.pdf`,
};

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  new_individual: "New - Individual",
  mod_individual: "Modify - Individual",
  renew_individual: "Renew - Individual",
  bulk_new: "New - Bulk",
  bulk_mod: "Modify / Renew - Bulk",
  deactivate_individual: "Deactivate - Individual",
  bulk_deactivate: "Deactivate - Bulk",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Splits a stored full name into first/last for the PDF and spreadsheet name
 * fields. The Person model has only a single `name`, so this is a heuristic:
 * the final whitespace-separated token is the last name, everything before it
 * is the first/middle name. A single-token name (mononym) yields an empty last
 * name rather than duplicating the first name into both fields.
 */
function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

// ---------------------------------------------------------------------------
// Spreadsheet generator
// ---------------------------------------------------------------------------

async function generateSpreadsheet(args: {
  requestType: RequestType;
  people: Array<{
    firstName: string;
    lastName: string;
    email: string;
    netId: string;
    epicId: string;
    mirrorEpicId: string;
  }>;
  endDate: string;
}): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const { requestType, people, endDate } = args;
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const isNew = requestType.includes("new");

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Epic Request");

  const headers = [
    "Last Name", "First Name", "Middle Name", "E-Mail Address",
    "Government Issued ID # (In case of provider, NPI # is needed)",
    "Role", "Job Title/ Position", "Start Date", "End Date",
    "Currently works at YNHHS?", "Yale University ID",
    "Previous Student - YNHHS Network ID", "Epic ID", "Epic ID to Mirror",
  ];

  // Add and style header row.
  const headerRow = ws.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF006B8A" } };
    cell.font = { bold: true, color: { argb: "FFFFFF00" } };
    cell.alignment = { wrapText: true };
  });

  // Add data rows. Each row carries its own mirror Epic ID since bulk requests
  // can span multiple departments — there is no single shared mirror anymore.
  for (const p of people) {
    const row = ws.addRow([
      p.lastName, p.firstName, "", p.email, "",
      "Yale College (Student)", "Yale College (Student)",
      today, endDate, "No", p.netId, "",
      isNew ? "" : p.epicId, p.mirrorEpicId,
    ]);
    row.eachCell((cell) => {
      cell.alignment = { wrapText: true };
    });
  }

  // Auto column widths.
  ws.columns.forEach((col, i) => {
    const maxLen = Math.max(
      headers[i]?.length ?? 10,
      ...people.map((p) => {
        const vals = [p.lastName, p.firstName, "", p.email, "", "Yale College (Student)", "Yale College (Student)", today, endDate, "No", p.netId, "", isNew ? "" : p.epicId, p.mirrorEpicId];
        return String(vals[i] ?? "").length;
      })
    );
    col.width = Math.min(40, maxLen + 4);
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  // Auth check — only signed-in admin.access holders can generate Epic forms.
  // (Same primitives as other API routes; requirePermission is page-only since
  // it redirects on failure.) The resolved person is also the tracking actor.
  const session = await auth();
  if (!session?.personId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actor = await getActivePerson(session.personId);
  if (!actor || !(await can(actor.id, "admin.access"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json() as {
    requestType: RequestType;
    authorizerId: string;
    personIds: string[];
    endDate: string;
  };

  const { requestType, authorizerId, personIds, endDate } = body;

  if (!Object.prototype.hasOwnProperty.call(PDF_FILENAMES, requestType)) {
    return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }

  if (!Object.prototype.hasOwnProperty.call(EMAIL_BODIES, requestType)) {
    return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }

  // Resolve the authorizer from the current term's ITCM directors rather than a
  // hardcoded directory, and re-resolve server-side so the rendered name/phone/
  // email come from the trusted person record, not the client.
  const authorizer = (await listEpicAuthorizers()).find((a) => a.id === authorizerId);
  if (!authorizer) {
    return NextResponse.json({ error: "Selected authorizer is not a current ITCM director" }, { status: 400 });
  }

  if (!personIds?.length) {
    return NextResponse.json({ error: "No people selected" }, { status: 400 });
  }

  // Deactivation requests default to today if no end date is provided.
  const isDeactivate = requestType === "deactivate_individual" || requestType === "bulk_deactivate";

  // Modify/renew requests carry an access end date; new requests use a fixed
  // one-year-out date instead; deactivation defaults to today.
  // Require it only for non-new, non-deactivate types so a blank date never reaches YNHH.
  if (!requestType.includes("new") && !isDeactivate && !endDate?.trim()) {
    return NextResponse.json(
      { error: "An end date is required for modify/renew requests" },
      { status: 400 }
    );
  }

  const todayMMDDYYYY = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const effectiveEndDate = isDeactivate && !endDate?.trim() ? todayMMDDYYYY : endDate;

  // Load people from the database.
  const people = await getPeopleByIds(personIds);
  if (people.length !== personIds.length) {
    return NextResponse.json(
      { error: "Some selected people no longer exist. Refresh and try again." },
      { status: 400 }
    );
  }

  // Resolve the active term once and reuse it for both membership lookups.
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  // Find a mirror Epic ID per selected person, based on THEIR OWN department
  // and role — bulk requests can now span multiple departments, so there is
  // no single global mirror; each spreadsheet row gets its own.
  const mirrorByPersonId = new Map<string, { name: string; epicId: string } | null>();
  if (activeTerm) {
    const memberships = await prisma.termMembership.findMany({
      where: {
        personId: { in: people.map((p) => p.id) },
        termId: activeTerm.id,
        status: "ACTIVE",
      },
    });
    for (const m of memberships) {
      const mirror = await findMirrorPerson(m.departmentId, m.kind, {
        excludePersonIds: people.map((p) => p.id),
        termId: activeTerm.id,
      });
      mirrorByPersonId.set(m.personId, mirror);
    }
  }

  // For individual requests there's exactly one person, so this is their mirror.
  const singleMirrorPerson = mirrorByPersonId.get(people[0].id) ?? null;

 const templatePath = path.join(process.cwd(), "public", "templates", "epic-request-template.pdf");
  let templateBytes: Uint8Array;
  try {
    templateBytes = new Uint8Array(fs.readFileSync(templatePath));
  } catch {
    return NextResponse.json(
      { error: "PDF template not found at public/templates/epic-request-template.pdf" },
      { status: 500 }
    );
  }

  

  const isBulk = requestType.startsWith("bulk");
  const isNew = requestType.includes("new");

  // Build person shape for individual requests.
  const firstPerson = people[0];
  const { firstName, lastName } = splitName(firstPerson.name);

  const personArg = isBulk ? null : {
    firstName,
    lastName,
    email: firstPerson.contactEmail ?? "",
    netId: firstPerson.netId ?? "",
    epicId: firstPerson.epicId ?? "",
    yaleAffiliation: firstPerson.yaleAffiliation ?? "",
  };

  // Generate PDF. Bulk requests pass no single mirror — itcm-pdf.ts should
  // print "See spreadsheet" for "person with similar job functions" instead.
  const pdfBytes = await generatePdf({
    requestType,
    authorizer,
    person: personArg,
    endDate: effectiveEndDate,
    mirrorPerson: isBulk ? null : singleMirrorPerson,
    templateBytes,
  });

  // Build date string for filenames.
  const now = new Date();
  const dateStr = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${now.getFullYear()}`;
  // Build filename using validated switch to satisfy CodeQL dynamic call check.
  // The authorizer's initials (derived from their name) stand in for the old
  // hardcoded CC/RT/JC keys in the filename.
  const initials = authorizer.initials;
  let pdfFilename: string;
  switch (requestType) {
    case "new_individual": pdfFilename = PDF_FILENAMES.new_individual(initials, dateStr); break;
    case "mod_individual": pdfFilename = PDF_FILENAMES.mod_individual(initials, dateStr); break;
    case "renew_individual": pdfFilename = PDF_FILENAMES.renew_individual(initials, dateStr); break;
    case "bulk_new": pdfFilename = PDF_FILENAMES.bulk_new(initials, dateStr); break;
    case "bulk_mod": pdfFilename = PDF_FILENAMES.bulk_mod(initials, dateStr); break;
    case "deactivate_individual": pdfFilename = PDF_FILENAMES.deactivate_individual(initials, dateStr); break;
    case "bulk_deactivate": pdfFilename = PDF_FILENAMES.bulk_deactivate(initials, dateStr); break;
    default: return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }

  // Build email body.
  const oneYearOut = new Date();
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
  const oneYearStr = oneYearOut.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

  const emailBodyArgs = {
    personName: isBulk ? "Multiple Users" : firstPerson.name,
    epicId: firstPerson.epicId ?? "",
    endDate: isNew ? oneYearStr : effectiveEndDate,
    authorizerName: authorizer.name,
    userCount: people.length,
  };

  // Build email body using validated switch to satisfy CodeQL dynamic call check.
  let emailBody: string;
  switch (requestType) {
    case "new_individual": emailBody = EMAIL_BODIES.new_individual(emailBodyArgs); break;
    case "mod_individual": emailBody = EMAIL_BODIES.mod_individual(emailBodyArgs); break;
    case "renew_individual": emailBody = EMAIL_BODIES.renew_individual(emailBodyArgs); break;
    case "bulk_new": emailBody = EMAIL_BODIES.bulk_new(emailBodyArgs); break;
    case "bulk_mod": emailBody = EMAIL_BODIES.bulk_mod(emailBodyArgs); break;
    case "deactivate_individual": emailBody = EMAIL_BODIES.deactivate_individual(emailBodyArgs); break;
    case "bulk_deactivate": emailBody = EMAIL_BODIES.bulk_deactivate(emailBodyArgs); break;
    default: return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  };

  // Generate spreadsheet for bulk requests.
  let xlsxBase64: string | null = null;
  let xlsxFilename: string | null = null;

  if (isBulk) {
    const peopleRows = people.map((p) => {
      const { firstName: rowFirst, lastName: rowLast } = splitName(p.name);
      return {
        firstName: rowFirst,
        lastName: rowLast,
        email: p.contactEmail ?? "",
        netId: p.netId ?? "",
        epicId: p.epicId ?? "",
        mirrorEpicId: mirrorByPersonId.get(p.id)?.epicId ?? "",
      };
    });

    const xlsxBuffer = await generateSpreadsheet({
      requestType,
      people: peopleRows,
      endDate: effectiveEndDate,
    });

    xlsxBase64 = xlsxBuffer.toString("base64");
    xlsxFilename = pdfFilename.replace(".pdf", ".xlsx");
  }

  // Create one YnhhTicket per PDF submission to group the requests together.
  // Service request number and close date are filled in manually when YNHH responds.
  // The actor is the signed-in admin who generated the request (resolved above),
  // so tracking is always recorded - never silently skipped.
  const ticket = await prisma.ynhhTicket.create({
    data: {
      submittedById: actor.id,
      description: `${REQUEST_TYPE_LABELS[requestType]} - ${people.map((p) => p.name).join(", ")}`,
      status: "OPEN",
    },
  });

  if (isDeactivate) {
    // Deactivation requests already exist (queued at offboard) or are created
    // here for an ad-hoc deactivation; link them to this ticket as SUBMITTED.
    await reconcileDeactivationRequests(actor.id, people.map((p) => p.id), ticket.id);
  } else {
    // Record Epic requests for tracking.
    // kind maps: new_individual/bulk_new -> NEW, mod_individual -> MODIFY,
    // renew_individual/bulk_mod -> RENEW.
    const epicKind =
      requestType === "new_individual" || requestType === "bulk_new"
        ? "NEW"
        : requestType === "mod_individual"
        ? "MODIFY"
        : "RENEW";

    await prisma.$transaction(
      people.map((p) =>
        prisma.epicRequest.create({
          data: {
            personId: p.id,
            kind: epicKind,
            status: "SUBMITTED",
            mirrorEpicId: mirrorByPersonId.get(p.id)?.epicId ?? null,
            requestedById: actor.id,
            ticketId: ticket.id,
          },
        })
      )
    );
  }

  return NextResponse.json({
    pdfBase64: Buffer.from(pdfBytes).toString("base64"),
    pdfFilename,
    xlsxBase64,
    xlsxFilename,
    emailBody,
  });
}










