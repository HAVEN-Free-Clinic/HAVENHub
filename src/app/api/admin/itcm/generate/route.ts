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
import { PDFDocument, PDFName, PDFBool, StandardFonts } from "pdf-lib";
import * as fs from "fs";
import * as path from "path";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { findMirrorPerson, getPeopleByIds } from "@/modules/admin/services/itcm";
import { prisma } from "@/platform/db";



// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHORIZERS = {
  CC: { name: "Caprice Culkin", phone: "720-254-2589", email: "caprice.culkin@yale.edu" },
  RT: { name: "Renee Tracey", phone: "201-815-6054", email: "renee.tracey@yale.edu" },
  JC: { name: "Jack Carney", phone: "585-689-9720", email: "j.carney@yale.edu" },
} as const;
type AuthorizerKey = keyof typeof AUTHORIZERS;

type RequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod";

const SECTION_IX: Record<RequestType, string> = {
  new_individual:
    "This individual requires a NEW Epic account, and require access to the department YM HAVEN FREE CLINIC. Their account should have similar functions of the aforementioned Epic ID to mirror within the department YM HAVEN FREE CLINIC.",
  mod_individual:
    "This individual already has an Epic account, but they require extended access to the department YM HAVEN FREE CLINIC. Their account should also have similar functions of the aforementioned Epic ID to mirror within the department YM HAVEN FREE CLINIC.",
  renew_individual:
    "This individual already has an Epic account, but they require extended access to the department YM HAVEN FREE CLINIC. Their account should also have similar functions of the aforementioned Epic ID to mirror within the department YM HAVEN FREE CLINIC.",
  bulk_new:
    "These individuals require NEW Epic accounts, and require access to the department YM HAVEN FREE CLINIC. Their accounts should have similar functions of the aforementioned Epic ID to mirror within the department YM HAVEN FREE CLINIC. Please see the attached spreadsheet for the multiple user information.",
  bulk_mod:
    "These individuals already have Epic accounts, but they require extended access to the department YM HAVEN FREE CLINIC. Their accounts should also have similar functions of the aforementioned Epic ID to mirror within the department YM HAVEN FREE CLINIC. Please see the attached spreadsheet for the multiple user information.",
};

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
};

const PDF_FILENAMES: Record<RequestType, (initials: string, date: string) => string> = {
  new_individual: (i, d) => `${i} ${d} NEW Service Request Form_V5.5.pdf`,
  mod_individual: (i, d) => `${i} ${d} MOD_REACT Service Request Form_V5.5.pdf`,
  renew_individual: (i, d) => `${i} ${d} MOD_REACT Service Request Form_V5.5.pdf`,
  bulk_new: (i, d) => `${i} ${d} Multiple Users NEW Service Request Form_V5.5.pdf`,
  bulk_mod: (i, d) => `${i} ${d} Multiple Users MOD_REACT Service Request Form_V5.5.pdf`,
};

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  new_individual: "New — Individual",
  mod_individual: "Modify — Individual",
  renew_individual: "Renew — Individual",
  bulk_new: "New — Bulk",
  bulk_mod: "Modify / Renew — Bulk",
};

// ---------------------------------------------------------------------------
// Checkbox helper
// ---------------------------------------------------------------------------

/**
 * Checks a PDF form checkbox by setting its value to /Yes and its appearance
 * state to /Yes. pdf-lib's built-in check() sometimes fails on non-standard
 * checkbox widgets; direct annotation mutation is more reliable.
 */
function checkBox(form: ReturnType<PDFDocument["getForm"]>, fieldName: string) {
  try {
    const field = form.getCheckBox(fieldName);
    field.check();
  } catch {
    // Field missing or not a checkbox: log so a re-versioned template surfaces
    // instead of silently shipping an unchecked box.
    console.warn(`[itcm] PDF checkbox not set: "${fieldName}"`);
  }
}

function fillText(form: ReturnType<PDFDocument["getForm"]>, fieldName: string, value: string) {
  try {
    const field = form.getTextField(fieldName);
    field.setText(value);
  } catch {
    // Field missing: log so a re-versioned template surfaces instead of
    // silently shipping a blank field.
    console.warn(`[itcm] PDF text field not set: "${fieldName}"`);
  }
}

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
// PDF generator
// ---------------------------------------------------------------------------

async function generatePdf(args: {
  requestType: RequestType;
  authorizerKey: AuthorizerKey;
  person: { firstName: string; lastName: string; email: string; netId: string; epicId: string; yaleAffiliation: string } | null;
  endDate: string;
  mirrorPerson: { name: string; epicId: string } | null;
  templateBytes: Uint8Array;
}): Promise<Uint8Array> {
  const { requestType, authorizerKey, person, endDate, mirrorPerson, templateBytes } = args;
  const auth = AUTHORIZERS[authorizerKey];
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const isBulk = requestType.startsWith("bulk");
  const isNew = requestType.includes("new");

  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  form.updateFieldAppearances(helv);
  form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);


  // Section I — Authorizer
  fillText(form, "Text1", auth.name);
  fillText(form, "Text2", "HAVEN IT & Communications Director");
  fillText(form, "Text3", auth.phone);
  fillText(form, "Text4", today);
  fillText(form, "Text5", auth.email);

  // Section III — Person info
  if (isBulk) {
    fillText(form, "Text12", "See spreadsheet");
    fillText(form, "Text18", "See spreadsheet");
    fillText(form, "Text19", "See spreadsheet");
    fillText(form, "Text23", "See spreadsheet");
    fillText(form, "Text29", "See spreadsheet");
  } else if (person) {
    fillText(form, "Text12", person.firstName);
    fillText(form, "Text18", person.lastName);
    fillText(form, "Text19", person.email);
    fillText(form, "Text23", person.netId);
    if (!isNew) fillText(form, "Text17", "  " + person.epicId);
  }

  // Section III — always-fixed fields
  fillText(form, "Text14", "203-936-8705");
  fillText(form, "Text15", "800 Howard Avenue 06519");
  fillText(form, "Text21", "Floor 1");

  // Section IV — Affiliation + position
  fillText(form, "Text28", "YM HAVEN FREE CLINIC");
  checkBox(form, "Check Box1");
  checkBox(form, "Check Box40");

  if (!isBulk) {
    checkBox(form, "Check Box21");
    const affiliation = (person?.yaleAffiliation ?? "").toLowerCase();
    if (affiliation.includes("med") || affiliation.includes("medicine")) {
      checkBox(form, "Check Box45");
    }
    if (person?.yaleAffiliation) {
      fillText(form, "Text29", person?.yaleAffiliation);
    }
  }

  // Section V — Access type + similar person
  if (isNew) {
    checkBox(form, "Check Box49");
    fillText(form, "Text75", today);
  } else {
    checkBox(form, "Check Box51");
    checkBox(form, "Check Box53");
    checkBox(form, "Check Box54");
    checkBox(form, "Check Box56");
    fillText(form, "Text76", endDate);
  }

  if (mirrorPerson) {
    fillText(form, "Text78", mirrorPerson.name);
    fillText(form, "Text79", "  " + mirrorPerson.epicId);
  }

  // Section VI — System access
  checkBox(form, "Check Box64");
  checkBox(form, "Remote Access");

  // Section IX
  try {
    const field = form.getTextField("Text113");
    field.setText(SECTION_IX[requestType]);
    field.setFontSize(8);
  } catch {
    // skip
  }

  // Force every field to regenerate its appearance stream, since stale or
  // missing streams on the original template can cause updateFieldAppearances
  // to silently skip fields whose value pdf-lib doesn't think changed.
  for (const field of form.getFields()) {
    form.markFieldAsDirty(field.ref);
  }
  form.updateFieldAppearances(helv);

  return pdfDoc.save();
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
  }>;
  endDate: string;
  mirrorEpicId: string;
}): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const { requestType, people, endDate, mirrorEpicId } = args;
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

  // Add data rows.
  for (const p of people) {
    const row = ws.addRow([
      p.lastName, p.firstName, "", p.email, "",
      "Yale College (Student)", "Yale College (Student)",
      today, endDate, "No", p.netId, "",
      isNew ? "" : p.epicId, mirrorEpicId,
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
        const vals = [p.lastName, p.firstName, "", p.email, "", "Yale College (Student)", "Yale College (Student)", today, endDate, "No", p.netId, "", isNew ? "" : p.epicId, mirrorEpicId];
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
    authorizerKey: AuthorizerKey;
    personIds: string[];
    endDate: string;
  };

  const { requestType, authorizerKey, personIds, endDate } = body;

  if (!Object.prototype.hasOwnProperty.call(PDF_FILENAMES, requestType)) {
    return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }

  if (!Object.prototype.hasOwnProperty.call(EMAIL_BODIES, requestType)) {
    return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }

  if (!Object.prototype.hasOwnProperty.call(AUTHORIZERS, authorizerKey)) {
    return NextResponse.json({ error: "Invalid authorizer key" }, { status: 400 });
  }

  if (!personIds?.length) {
    return NextResponse.json({ error: "No people selected" }, { status: 400 });
  }

  // Modify/renew requests carry an access end date; new requests use a fixed
  // one-year-out date instead. Require it so a blank date never reaches YNHH.
  if (!requestType.includes("new") && !endDate?.trim()) {
    return NextResponse.json(
      { error: "An end date is required for modify/renew requests" },
      { status: 400 }
    );
  }

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

  // Find a department/role to mirror from. Bulk selections are constrained to a
  // single department by the form, so any selected person's active membership
  // gives the right department; using the first one that actually has a
  // membership avoids a blank mirror when the alphabetically-first person lacks one.
  let mirrorPerson: { name: string; epicId: string } | null = null;
  if (activeTerm) {
    const membership = await prisma.termMembership.findFirst({
      where: {
        personId: { in: people.map((p) => p.id) },
        termId: activeTerm.id,
        status: "ACTIVE",
      },
    });
    if (membership) {
      mirrorPerson = await findMirrorPerson(membership.departmentId, membership.kind, {
        excludePersonIds: people.map((p) => p.id),
        termId: activeTerm.id,
      });
    }
  }

  // Load the PDF template from the public/templates directory.
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
  const authorizer = AUTHORIZERS[authorizerKey];

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

  // Generate PDF.
  const pdfBytes = await generatePdf({
    requestType,
    authorizerKey,
    person: personArg,
    endDate,
    mirrorPerson,
    templateBytes,
  });

  // Build date string for filenames.
  const now = new Date();
  const dateStr = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${now.getFullYear()}`;
  // Build filename using validated switch to satisfy CodeQL dynamic call check.
  let pdfFilename: string;
  switch (requestType) {
    case "new_individual": pdfFilename = PDF_FILENAMES.new_individual(authorizerKey, dateStr); break;
    case "mod_individual": pdfFilename = PDF_FILENAMES.mod_individual(authorizerKey, dateStr); break;
    case "renew_individual": pdfFilename = PDF_FILENAMES.renew_individual(authorizerKey, dateStr); break;
    case "bulk_new": pdfFilename = PDF_FILENAMES.bulk_new(authorizerKey, dateStr); break;
    case "bulk_mod": pdfFilename = PDF_FILENAMES.bulk_mod(authorizerKey, dateStr); break;
    default: return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }

  // Build email body.
  const oneYearOut = new Date();
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
  const oneYearStr = oneYearOut.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

  const emailBodyArgs = {
    personName: isBulk ? "Multiple Users" : firstPerson.name,
    epicId: firstPerson.epicId ?? "",
    endDate: isNew ? oneYearStr : endDate,
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
      };
    });

    const xlsxBuffer = await generateSpreadsheet({
      requestType,
      people: peopleRows,
      endDate,
      mirrorEpicId: mirrorPerson?.epicId ?? "",
    });

    xlsxBase64 = xlsxBuffer.toString("base64");
    xlsxFilename = pdfFilename.replace(".pdf", ".xlsx");
  }

  // Record Epic requests and a YNHH ticket in the database for tracking.
  // kind maps: new_individual/bulk_new → NEW, mod_individual → MODIFY,
  // renew_individual/bulk_mod → RENEW.
  const epicKind =
    requestType === "new_individual" || requestType === "bulk_new"
      ? "NEW"
      : requestType === "mod_individual"
      ? "MODIFY"
      : "RENEW";

  // Create one YnhhTicket per PDF submission to group the requests together.
  // Service request number and close date are filled in manually when YNHH responds.
  // The actor is the signed-in admin who generated the request (resolved above),
  // so tracking is always recorded — never silently skipped.
  const ticket = await prisma.ynhhTicket.create({
    data: {
      submittedById: actor.id,
      description: `${REQUEST_TYPE_LABELS[requestType]} — ${people.map((p) => p.name).join(", ")}`,
      status: "OPEN",
    },
  });

  await prisma.$transaction(
    people.map((p) =>
      prisma.epicRequest.create({
        data: {
          personId: p.id,
          kind: epicKind,
          status: "SUBMITTED",
          mirrorEpicId: mirrorPerson?.epicId ?? null,
          requestedById: actor.id,
          ticketId: ticket.id,
        },
      })
    )
  );

  return NextResponse.json({
    pdfBase64: Buffer.from(pdfBytes).toString("base64"),
    pdfFilename,
    xlsxBase64,
    xlsxFilename,
    emailBody,
  });
}










