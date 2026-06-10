/**
 * POST /api/admin/itcm/generate
 *
 * Generates a filled YNHH Electronic Service Request PDF for one of five
 * Epic access request scenarios, plus an Excel spreadsheet for bulk requests.
 * Returns base64-encoded file payloads and a pre-written email body so the
 * client can trigger downloads and show the draft without a second round-trip.
 *
 * The PDF template (BLANK_Service_Request_Form_V5_5.pdf) lives at
 * public/templates/epic-request-template.pdf. It must be committed to the
 * repo; this route reads it at runtime via the filesystem.
 *
 * Mirror person logic: finds another ACTIVE member in the same department
 * with the same role who already has an epicId. Directors mirror directors,
 * volunteers mirror volunteers.
 *
 * Auth: requirePermission("admin.access") — only platform admins and ITCM
 * directors reach this route.
 */

import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import * as fs from "fs";
import * as path from "path";
import { requirePermission } from "@/platform/auth/session";
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
    // Field not found or not a checkbox — skip silently.
  }
}

function fillText(form: ReturnType<PDFDocument["getForm"]>, fieldName: string, value: string) {
  try {
    const field = form.getTextField(fieldName);
    field.setText(value);
  } catch {
    // Field not found — skip silently.
  }
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
  checkBox(form, "Check Box1");   // Electronic signature
  checkBox(form, "Check Box40");  // Community Connect Practice

  if (!isBulk) {
    checkBox(form, "Check Box21"); // Student (outer)
    // Check the correct student sub-type based on Yale affiliation.
    const affiliation = (person?.yaleAffiliation ?? "").toLowerCase();
    if (affiliation.includes("med") || affiliation.includes("medicine")) {
      checkBox(form, "Check Box45"); // Med Student
    }
    // All others (Yale College, GSAS, etc.) leave sub-type unchecked --
    // the position "Other" text field (Text29) carries the affiliation label.
    if (!isBulk && person?.yaleAffiliation) {
      fillText(form, "Text29", person?.yaleAffiliation);
    }
  }

  // Section V — Access type + similar person
  if (isNew) {
    checkBox(form, "Check Box49"); // New Hire
    fillText(form, "Text75", today);
  } else {
    checkBox(form, "Check Box51"); // Modify Access
    checkBox(form, "Check Box53"); // Transfer? No
    checkBox(form, "Check Box54"); // Current access needed? Yes
    checkBox(form, "Check Box56"); // Additional access required? Yes
    fillText(form, "Text76", endDate);
  }

  if (mirrorPerson) {
    fillText(form, "Text78", mirrorPerson.name);
    fillText(form, "Text79", "  " + mirrorPerson.epicId);
  }

  // Section VI — System access
  checkBox(form, "Check Box64");   // Epic
  checkBox(form, "Remote Access"); // Remote Access

  // Section IX — Additional information (font size reduced for wrapping)
  try {
    const field = form.getTextField("Text113");
    field.setText(SECTION_IX[requestType]);
    field.setFontSize(8);
  } catch {
    // skip
  }


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
  // Auth check — only admin.access users can generate Epic request forms.
  try {
    await requirePermission("admin.access");
  } catch {
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

  // Load people from the database.
  const people = await getPeopleByIds(personIds);
  if (people.length === 0) {
    return NextResponse.json({ error: "Selected people not found" }, { status: 400 });
  }

  // Find the first person's department and role for mirror lookup.
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  let mirrorPerson: { name: string; epicId: string } | null = null;
  if (activeTerm) {
    const firstMembership = await prisma.termMembership.findFirst({
      where: { personId: people[0].id, termId: activeTerm.id, status: "ACTIVE" },
    });
    if (firstMembership) {
      mirrorPerson = await findMirrorPerson(
        firstMembership.departmentId,
        firstMembership.kind,
        people[0].id
      );
    }
  }

  // Load the PDF template from the public/templates directory.
  const templatePath = path.join(process.cwd(), "public", "templates", "epic-request-template.pdf");
  let templateBytes: Uint8Array;
  try {
    templateBytes = new Uint8Array(fs.readFileSync(templatePath));
  } catch {
    return NextResponse.json(
      { error: "PDF template not found. Place BLANK_Service_Request_Form_V5_5.pdf at public/templates/epic-request-template.pdf" },
      { status: 500 }
    );
  }

  const isBulk = requestType.startsWith("bulk");
  const isNew = requestType.includes("new");
  const auth = AUTHORIZERS[authorizerKey];

  // Build person shape for individual requests.
  const firstPerson = people[0];
  const nameParts = firstPerson.name.trim().split(" ");
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.slice(1).join(" ") || firstName;

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
  const pdfFilenameBuilder = PDF_FILENAMES[requestType];
  if (typeof pdfFilenameBuilder !== "function") {
    return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }
  const pdfFilename = pdfFilenameBuilder(authorizerKey, dateStr);

  // Build email body.
  const oneYearOut = new Date();
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
  const oneYearStr = oneYearOut.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

  const emailBodyArgs = {
    personName: isBulk ? "Multiple Users" : firstPerson.name,
    epicId: firstPerson.epicId ?? "",
    endDate: isNew ? oneYearStr : endDate,
    authorizerName: auth.name,
    userCount: people.length,
  };

  const emailBodyBuilder = EMAIL_BODIES[requestType];
  if (typeof emailBodyBuilder !== "function") {
    return NextResponse.json({ error: "Invalid request type" }, { status: 400 });
  }
  const emailBody = emailBodyBuilder(emailBodyArgs);

  // Generate spreadsheet for bulk requests.
  let xlsxBase64: string | null = null;
  let xlsxFilename: string | null = null;

  if (isBulk) {
    const peopleRows = people.map((p) => {
      const parts = p.name.trim().split(" ");
      return {
        firstName: parts[0] ?? "",
        lastName: parts.slice(1).join(" ") || (parts[0] ?? ""),
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

  return NextResponse.json({
    pdfBase64: Buffer.from(pdfBytes).toString("base64"),
    pdfFilename,
    xlsxBase64,
    xlsxFilename,
    emailBody,
  });
}