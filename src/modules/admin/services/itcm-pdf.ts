/**
 * itcm-pdf: fills the YNHH Electronic Service Request PDF template for an Epic
 * access request.
 *
 * Extracted from the /api/admin/itcm/generate route so the generator can be
 * unit-tested without standing up the route's auth/database dependencies.
 *
 * Appearance handling (why NeedAppearances must be false):
 * The template ships with the AcroForm `NeedAppearances` flag set. With that
 * flag on, Adobe Acrobat ignores the appearance streams pdf-lib writes and
 * regenerates each field's appearance itself from the field's
 * default-appearance font (a font the template does not embed) and renders
 * the field blank. (Chrome and Preview regenerate successfully, which is why
 * the form looked filled in some viewers and blank in Acrobat.) So we embed a
 * font, regenerate every field's appearance stream after filling, and then
 * clear NeedAppearances so every viewer renders the streams we produced.
 * Flattening would also work but the template contains an orphan widget with a
 * broken page reference that makes pdf-lib's form.flatten() throw, and keeping
 * the form fillable is preferable for YNHH.
 *
 * Checkbox marks (why we redraw them as vector paths):
 * The template draws a checked box's mark with a glyph (the "!" character) from
 * a subsetted ZapfDingbats TrueType font. Adobe Acrobat fails to render that
 * embedded subset, so checked boxes appear blank in Acrobat even though the box
 * itself draws (the unchecked/checked appearances share the same font-free box
 * drawing; only the checked one adds the glyph). pdf-lib's appearance
 * regeneration skips checkboxes whose appearance state already exists, so it
 * never fixed them. After filling, we replace each checked box's on-state
 * appearance with the original box drawing plus a font-free vector checkmark,
 * which every viewer (Acrobat included) renders.
 */

import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
} from "pdf-lib";

/**
 * Section I authorizer details. Resolved by the caller from the current term's
 * ITCM director (see listEpicAuthorizers) rather than a hardcoded directory, so
 * the name/phone/email always come from a real person record.
 */
export type Authorizer = { name: string; phone: string; email: string };

export type RequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod"
  | "deactivate_individual"
  | "bulk_deactivate";

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
  deactivate_individual:
    "This individual is leaving the YM HAVEN FREE CLINIC. Please DEACTIVATE their Epic access for the department YM HAVEN FREE CLINIC effective on the listed date.",
  bulk_deactivate:
    "These individuals are leaving the YM HAVEN FREE CLINIC. Please DEACTIVATE their Epic access for the department YM HAVEN FREE CLINIC. Please see the attached spreadsheet for the multiple user information.",
};

// ---------------------------------------------------------------------------
// Field helpers
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
 * A checkmark drawn as a stroked path, sized to a box of the given dimensions.
 * Uses device gray and no font, so every PDF viewer (Adobe Acrobat included)
 * can render it. `x0`/`y0` are the box's BBox origin.
 */
function vectorCheckmarkOps(x0: number, y0: number, width: number, height: number): string {
  const px = (f: number) => (x0 + f * width).toFixed(2);
  const py = (f: number) => (y0 + f * height).toFixed(2);
  const lineWidth = (Math.min(width, height) * 0.11).toFixed(2);
  return [
    "q",
    "0 G", // black stroke (device gray)
    `${lineWidth} w 1 J 1 j`, // round caps and joins
    `${px(0.25)} ${py(0.51)} m`, // start of the left arm
    `${px(0.42)} ${py(0.32)} l`, // down to the bottom vertex
    `${px(0.76)} ${py(0.75)} l`, // up to the top-right tip
    "S",
    "Q",
  ].join("\n");
}

/** The fully-qualified field name of a widget, walking the /Parent chain. */
function widgetFieldName(widget: PDFDict): string | undefined {
  const parts: string[] = [];
  const seen = new Set<PDFDict>();
  let node: PDFDict | undefined = widget;
  while (node && !seen.has(node)) {
    seen.add(node);
    const t = node.get(PDFName.of("T"));
    if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText());
    node = node.lookupMaybe(PDFName.of("Parent"), PDFDict);
  }
  return parts.length ? parts.join(".") : undefined;
}

/**
 * Puts a checkbox widget into the checked state and replaces its on-state
 * appearance with the box's existing off-state drawing plus a font-free vector
 * checkmark. The template's own checkmark uses a subsetted ZapfDingbats glyph
 * that Adobe Acrobat fails to render (see file header); reusing the off-state
 * drawing keeps the box looking identical while the vector mark renders
 * everywhere. Operates on the widget dict directly so it can target the widget
 * a viewer renders (the one in a page's /Annots), not the orphan field copy.
 */
function setVectorCheckOnWidget(pdfDoc: PDFDocument, widget: PDFDict) {
  const apN = widget
    .lookupMaybe(PDFName.of("AP"), PDFDict)
    ?.lookupMaybe(PDFName.of("N"), PDFDict);
  if (!apN) return;
  const onValue = apN.keys().find((k) => k.toString() !== "/Off");
  if (!onValue) return;

  const offStream = apN.lookup(PDFName.of("Off"));
  const bbox = offStream instanceof PDFRawStream
    ? offStream.dict.lookupMaybe(PDFName.of("BBox"), PDFArray)
    : undefined;
  if (offStream instanceof PDFRawStream && bbox) {
    const x0 = bbox.lookup(0, PDFNumber).asNumber();
    const y0 = bbox.lookup(1, PDFNumber).asNumber();
    const x1 = bbox.lookup(2, PDFNumber).asNumber();
    const y1 = bbox.lookup(3, PDFNumber).asNumber();
    const offContent = Buffer.from(decodePDFRawStream(offStream).decode()).toString("latin1");
    const content = offContent + "\n" + vectorCheckmarkOps(x0, y0, x1 - x0, y1 - y0);
    const resources = offStream.dict.get(PDFName.of("Resources"));
    const newStream = pdfDoc.context.stream(content, {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: bbox,
      ...(resources ? { Resources: resources } : {}),
    });
    apN.set(onValue, pdfDoc.context.register(newStream));
  }

  // Mark the widget checked under every rendering model: by its own appearance
  // state (/AS) for viewers that render widgets directly, and by value (/V) for
  // form-aware viewers that merge same-named fields.
  widget.set(PDFName.of("AS"), onValue);
  widget.set(PDFName.of("V"), onValue);
}

// ---------------------------------------------------------------------------
// PDF generator
// ---------------------------------------------------------------------------

export async function generatePdf(args: {
  requestType: RequestType;
  authorizer: Authorizer;
  person: { firstName: string; lastName: string; email: string; netId: string; epicId: string; yaleAffiliation: string } | null;
  endDate: string;
  mirrorPerson: { name: string; epicId: string } | null;
  templateBytes: Uint8Array;
}): Promise<Uint8Array> {
  const { requestType, authorizer: auth, person, endDate, mirrorPerson, templateBytes } = args;
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  // The access-type checkbox that marks a request as a termination/deactivation.
  // Confirmed against the YNHH template (controller-verified, Task 6 Step 1):
  // "Check Box60" is the "Delete Access (Systems: ... Date: ...)" box in Section V.
  const TERMINATION_CHECKBOX: string | null = "Check Box60";
  const isBulk = requestType.startsWith("bulk");
  const isNew = requestType === "new_individual" || requestType === "bulk_new";
  const isDeactivate = requestType === "deactivate_individual" || requestType === "bulk_deactivate";

  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();

  // Embed a font now so the appearance regeneration at the end has a real,
  // embedded font to draw with rather than relying on the template's fonts.
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Section I: Authorizer
  fillText(form, "Text1", auth.name);
  fillText(form, "Text2", "HAVEN IT & Communications Director");
  fillText(form, "Text3", auth.phone);
  fillText(form, "Text4", today);
  fillText(form, "Text5", auth.email);

  // Section III: Person info
  // Section III: Person info
  if (isBulk) {
    fillText(form, "Text12", "See spreadsheet");
    fillText(form, "Text18", "See spreadsheet");
    fillText(form, "Text19", "See spreadsheet");
    fillText(form, "Text23", "See spreadsheet");
    checkBox(form, "Check Box21"); // Job Title row: "Other"
    fillText(form, "Text29", "See spreadsheet");
  } else if (person) {
    fillText(form, "Text12", person.firstName);
    fillText(form, "Text18", person.lastName);
    fillText(form, "Text19", person.email);
    fillText(form, "Text23", person.netId);
    if (!isNew) fillText(form, "Text17", "  " + person.epicId);
  }

  // Section III: always-fixed fields
  fillText(form, "Text14", "203-936-8705");
  fillText(form, "Text15", "800 Howard Avenue 06519");
  fillText(form, "Text21", "Floor 1");

  // Section IV: Affiliation + position
  fillText(form, "Text28", "YM HAVEN FREE CLINIC");
  checkBox(form, "Check Box1");
  checkBox(form, "Check Box40");

  if (!isBulk) {
    const affiliation = person?.yaleAffiliation ?? "";
    const isStaffOrOther = affiliation === "Yale Staff" || affiliation === "Other Yale Affiliation";
    const isMedStudent = affiliation.toLowerCase().includes("med");

    if (isStaffOrOther) {
      // Job Title row: "Other", with the affiliation text.
      checkBox(form, "Check Box21");
      fillText(form, "Text29", affiliation);
    } else if (isMedStudent) {
      // Student row: Med Student.
      checkBox(form, "Check Box45");
    } else if (affiliation) {
      // Student row: "Other", with the affiliation text.
      checkBox(form, "Check Box48");
      fillText(form, "Text30", affiliation);
    }
  }
  

  // Section V: Access type + similar person
  if (isNew) {
    checkBox(form, "Check Box49");
    fillText(form, "Text75", today); // New Hire start date; no end date on the PDF for New
  } else if (isDeactivate) {
    if (TERMINATION_CHECKBOX) checkBox(form, TERMINATION_CHECKBOX);
    fillText(form, "Text76", endDate); // effective deactivation date
  } else {
    checkBox(form, "Check Box51");
    checkBox(form, "Check Box53");
    checkBox(form, "Check Box54");
    checkBox(form, "Check Box56");
    fillText(form, "Text76", endDate);
  }

  if (isBulk && !isDeactivate) {
    checkBox(form, "Check Box58");
    fillText(form, "Text78", "See spreadsheet");
    fillText(form, "Text79", "See spreadsheet");
  } else if (mirrorPerson && !isDeactivate) {
    checkBox(form, "Check Box58");
    fillText(form, "Text78", mirrorPerson.name);
    fillText(form, "Text79", mirrorPerson.epicId);
  }

  // Section VI: System access
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

  // Redraw each checked box's mark as a font-free vector checkmark so Adobe
  // Acrobat renders it (the template's glyph-based mark is invisible there; see
  // file header). The template ships duplicate field objects: a widget on the
  // page plus an orphan copy in the field tree; pdf-lib's form API checks
  // the orphan, so we apply the state and mark to the widgets a viewer actually
  // renders: the ones in each page's /Annots, matched by field name.
  const checkedNames = new Set<string>();
  for (const field of form.getFields()) {
    if (field instanceof PDFCheckBox && field.isChecked()) checkedNames.add(field.getName());
  }
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const widget = pdfDoc.context.lookup(annots.get(i));
      if (!(widget instanceof PDFDict)) continue;
      const name = widgetFieldName(widget);
      if (name && checkedNames.has(name)) setVectorCheckOnWidget(pdfDoc, widget);
    }
  }

  // Tell every viewer to render the appearance streams we just generated.
  // Leaving NeedAppearances on makes Adobe Acrobat regenerate appearances from
  // a font the template never embedded and show blank fields (see file header).
  form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.False);

  return pdfDoc.save();
}
