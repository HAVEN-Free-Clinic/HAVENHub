import * as fs from "fs";
import * as path from "path";
import { decodePDFRawStream, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { epicPositionLabel, generatePdf } from "./itcm-pdf";

const templatePath = path.join(process.cwd(), "public", "templates", "epic-request-template.pdf");
const templateBytes = new Uint8Array(fs.readFileSync(templatePath));

const person = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane.doe@yale.edu",
  netId: "jd123",
  epicId: "EPIC123",
  yaleAffiliation: "Yale College",
};

const authorizer = { name: "Caprice Culkin", phone: "720-254-2589", email: "caprice.culkin@yale.edu" };

async function loadOutput() {
  const bytes = await generatePdf({
    requestType: "new_individual",
    authorizer,
    person,
    endDate: "10/15/2026",
    mirrorPerson: { name: "Mirror Person", epicId: "MIR456" },
    templateBytes,
  });
  return PDFDocument.load(bytes);
}

async function loadDeactivateIndividual() {
  const bytes = await generatePdf({
    requestType: "deactivate_individual",
    authorizer,
    person: { firstName: "Jane", lastName: "Doe", email: "jane.doe@yale.edu", netId: "jd123", epicId: "EPIC123", yaleAffiliation: "Yale College" },
    endDate: "10/15/2026",
    mirrorPerson: null,
    templateBytes,
  });
  return PDFDocument.load(bytes);
}

async function loadBulkDeactivate() {
  const bytes = await generatePdf({
    requestType: "bulk_deactivate",
    authorizer,
    person: null,
    endDate: "10/15/2026",
    mirrorPerson: null,
    templateBytes,
  });
  return PDFDocument.load(bytes);
}

describe("generatePdf deactivation", () => {
  it("fills the person's existing Epic ID on an individual deactivation", async () => {
    const doc = await loadDeactivateIndividual();
    const form = doc.getForm();
    // Epic ID field used for the account being deactivated (Text17 holds the
    // person's existing Epic ID on non-new requests).
    expect(form.getTextField("Text17").getText()).toContain("EPIC123");
  });

  it("checks the Delete Access box (Check Box60) on an individual deactivation", async () => {
    const doc = await loadDeactivateIndividual();
    // Check Box60 is the "Delete Access" box in Section V - the core
    // deactivation signal. This must be true and would fail if the Section V
    // deactivate branch did not check it.
    expect(doc.getForm().getCheckBox("Check Box60").isChecked()).toBe(true);
  });

  it("writes the deactivation Section IX narrative", async () => {
    const doc = await loadDeactivateIndividual();
    const form = doc.getForm();
    expect((form.getTextField("Text113").getText() ?? "").toLowerCase()).toContain("deactivat");
  });

  it("fills bulk Section III fields and checks Delete Access on a bulk deactivation", async () => {
    const doc = await loadBulkDeactivate();
    const form = doc.getForm();
    // Bulk requests fill Section III with "See spreadsheet" placeholders; the
    // mirror block is intentionally skipped for deactivation, so Text78/Text79
    // are not asserted here.
    expect(form.getTextField("Text12").getText()).toBe("See spreadsheet");
    expect(form.getCheckBox("Check Box60").isChecked()).toBe(true);
  });
});

describe("generatePdf", () => {
  it("clears NeedAppearances so Adobe Acrobat shows the filled text instead of a blank form", async () => {
    const doc = await loadOutput();
    const acro = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    const needAppearances = acro.get(PDFName.of("NeedAppearances"));
    // The template ships NeedAppearances=true, which makes Acrobat drop the
    // generated appearance streams and render blank. It must not survive as true.
    expect(String(needAppearances)).not.toBe("true");
  });

  it("writes an appearance stream for each filled field so viewers have something to render", async () => {
    const doc = await loadOutput();
    const form = doc.getForm();
    for (const name of ["Text1", "Text12", "Text18", "Text78"]) {
      const widgets = form.getTextField(name).acroField.getWidgets();
      const hasAppearance = widgets.some((w) => Boolean(w.getAppearances()?.normal));
      expect(hasAppearance, `${name} should have a normal appearance stream`).toBe(true);
    }
  });

  it("fills the authorizer and person fields with the supplied values", async () => {
    const doc = await loadOutput();
    const form = doc.getForm();
    // Authorizer name/phone/email come straight from the passed object (the
    // route resolves them from the current ITCM director's person record).
    expect(form.getTextField("Text1").getText()).toBe("Caprice Culkin");
    expect(form.getTextField("Text3").getText()).toBe("720-254-2589");
    expect(form.getTextField("Text5").getText()).toBe("caprice.culkin@yale.edu");
    expect(form.getTextField("Text12").getText()).toBe("Jane");
    expect(form.getTextField("Text18").getText()).toBe("Doe");
    expect(form.getTextField("Text78").getText()).toBe("Mirror Person");
  });

  // The template ships duplicate field objects: a widget on the page plus an
  // orphan copy in the AcroForm field tree. pdf-lib's form API mutates the
  // orphan, but viewers render the on-page widget, so the fix must reach the
  // widget in the page /Annots. That widget must (a) be in the checked state and
  // (b) draw its mark as a font-free vector path, because the template's
  // glyph-based mark (subsetted ZapfDingbats) is invisible in Adobe Acrobat.
  describe("checked checkboxes render in Adobe Acrobat", () => {
    // Finds the on-page widget annotation by field name (the object a viewer
    // actually renders), not the orphan field the form API returns.
    function renderedWidget(doc: PDFDocument, name: string) {
      for (const page of doc.getPages()) {
        const annots = page.node.Annots();
        if (!annots) continue;
        for (let i = 0; i < annots.size(); i++) {
          const widget = doc.context.lookupMaybe(annots.get(i), PDFDict);
          if (!widget) continue;
          const t = widget.get(PDFName.of("T"));
          const tName = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : undefined;
          if (tName !== name) continue;
          const apN = widget
            .lookupMaybe(PDFName.of("AP"), PDFDict)
            ?.lookupMaybe(PDFName.of("N"), PDFDict);
          if (!apN) throw new Error(`${name} widget has no /AP /N`);
          const onValue = apN.keys().find((k) => k.toString() !== "/Off");
          if (!onValue) throw new Error(`${name} widget has no on state`);
          const stream = apN.lookup(onValue);
          if (!(stream instanceof PDFRawStream)) throw new Error(`${name} on appearance is not a stream`);
          return {
            as: widget.get(PDFName.of("AS"))?.toString(),
            onValue: onValue.toString(),
            resources: stream.dict.lookupMaybe(PDFName.of("Resources"), PDFDict),
            content: Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"),
          };
        }
      }
      throw new Error(`${name} widget not found in any page /Annots`);
    }

    // new_individual checks these boxes (Section IV/V/VI):
    const CHECKED = ["Check Box1", "Check Box40", "Check Box49", "Check Box64", "Remote Access", "Check Box58"];

    it("sets the rendered widget's appearance state to its on value", async () => {
      const doc = await loadOutput();
      for (const name of CHECKED) {
        const w = renderedWidget(doc, name);
        expect(w.as, `${name} rendered widget /AS should be its on value`).toBe(w.onValue);
      }
    });

    it("draws the on-state mark without a font so Acrobat can render it", async () => {
      const doc = await loadOutput();
      for (const name of CHECKED) {
        const { resources, content } = renderedWidget(doc, name);
        expect(resources?.has(PDFName.of("Font")) ?? false, `${name} on appearance must not reference a font`).toBe(false);
        expect(content, `${name} on appearance must not draw text`).not.toMatch(/\bTf\b/);
      }
    });

    it("draws a vector checkmark (stroked path) in the on appearance", async () => {
      const doc = await loadOutput();
      for (const name of CHECKED) {
        const { content } = renderedWidget(doc, name);
        expect(content, `${name} should move-to`).toMatch(/\bm\b/);
        expect(content, `${name} should line-to`).toMatch(/\bl\b/);
        expect(content, `${name} should stroke`).toMatch(/\bS\b/);
      }
    });
  });
});

describe("Section IV affiliation routing", () => {
  async function loadWithAffiliation(yaleAffiliation: string) {
    const bytes = await generatePdf({
      requestType: "new_individual",
      authorizer,
      person: { ...person, yaleAffiliation },
      endDate: "10/15/2026",
      mirrorPerson: { name: "Mirror Person", epicId: "MIR456" },
      templateBytes,
    });
    return (await PDFDocument.load(bytes)).getForm();
  }

  it("checks Med Student for both YSM tracks", async () => {
    for (const value of ["ysm_md", "ysm_pa"]) {
      const form = await loadWithAffiliation(value);
      expect(form.getCheckBox("Check Box45").isChecked(), value).toBe(true);
      expect(form.getCheckBox("Check Box48").isChecked(), value).toBe(false);
      expect(form.getCheckBox("Check Box21").isChecked(), value).toBe(false);
    }
  });

  it("checks the Student Other row for a non-medical Yale school and writes the label", async () => {
    const form = await loadWithAffiliation("ysn");
    expect(form.getCheckBox("Check Box48").isChecked()).toBe(true);
    expect(form.getCheckBox("Check Box45").isChecked()).toBe(false);
    expect(form.getTextField("Text30").getText()).toBe("Yale School of Nursing (YSN)");
  });

  it("checks the Job Title Other row for staff and non-affiliates and writes the label", async () => {
    for (const [value, label] of [
      ["staff", "Yale Staff"],
      ["other_yale", "Other Yale Affiliation"],
      ["non_yale", "I am NOT a Yale Affiliate"],
    ]) {
      const form = await loadWithAffiliation(value);
      expect(form.getCheckBox("Check Box21").isChecked(), value).toBe(true);
      expect(form.getCheckBox("Check Box48").isChecked(), value).toBe(false);
      expect(form.getTextField("Text29").getText()).toBe(label);
    }
  });

  it("writes an unmapped legacy value through verbatim rather than blanking the row", async () => {
    const form = await loadWithAffiliation("Medical Student");
    expect(form.getCheckBox("Check Box48").isChecked()).toBe(true);
    expect(form.getTextField("Text30").getText()).toBe("Medical Student");
  });

  it("checks Med Student for the legacy /my-info YSM string, not Student Other", async () => {
    const form = await loadWithAffiliation("Yale School of Medicine");
    expect(form.getCheckBox("Check Box45").isChecked()).toBe(true);
    expect(form.getCheckBox("Check Box48").isChecked()).toBe(false);
  });

  it("checks Med Student for the legacy Physician Associate Program string", async () => {
    const form = await loadWithAffiliation("Physician Associate Program");
    expect(form.getCheckBox("Check Box45").isChecked()).toBe(true);
  });

  it("checks the Job Title Other row for the legacy 'Yale Staff' string", async () => {
    const form = await loadWithAffiliation("Yale Staff");
    expect(form.getCheckBox("Check Box21").isChecked()).toBe(true);
    expect(form.getTextField("Text29").getText()).toBe("Yale Staff");
  });

  it("checks the Student Other row for the legacy 'Yale College' string", async () => {
    const form = await loadWithAffiliation("Yale College");
    expect(form.getCheckBox("Check Box48").isChecked()).toBe(true);
    expect(form.getTextField("Text30").getText()).toBe("Yale College");
  });

  it("checks no affiliation row when the affiliation is blank", async () => {
    const form = await loadWithAffiliation("");
    for (const box of ["Check Box45", "Check Box48", "Check Box21"]) {
      expect(form.getCheckBox(box).isChecked(), box).toBe(false);
    }
  });
});

describe("epicPositionLabel (bulk spreadsheet Role / Job Title cell)", () => {
  it("labels both YSM tracks with YNHH's own Med Student wording", () => {
    expect(epicPositionLabel("ysm_md")).toBe("Med Student");
    expect(epicPositionLabel("ysm_pa")).toBe("Med Student");
  });

  it("labels every other Yale school as a student of that school", () => {
    expect(epicPositionLabel("ysn")).toBe("Yale School of Nursing (YSN) (Student)");
    expect(epicPositionLabel("yale_college")).toBe("Yale College (Student)");
    expect(epicPositionLabel("ysph")).toBe("Yale School of Public Health (YSPH) (Student)");
  });

  it("writes a non-student affiliation as a plain job title, with no student marker", () => {
    expect(epicPositionLabel("staff")).toBe("Yale Staff");
    expect(epicPositionLabel("other_yale")).toBe("Other Yale Affiliation");
    expect(epicPositionLabel("non_yale")).toBe("I am NOT a Yale Affiliate");
  });

  it("normalizes a legacy stored value so it routes like a canonical key", () => {
    // The backfill has not run, so most rows still hold one of these.
    expect(epicPositionLabel("Yale School of Medicine")).toBe("Med Student");
    expect(epicPositionLabel("Physician Associate Program")).toBe("Med Student");
    expect(epicPositionLabel("Yale Staff")).toBe("Yale Staff");
    expect(epicPositionLabel("  graduate school  ")).toBe(
      "Yale Graduate School of Arts and Sciences (GSAS) (Student)"
    );
  });

  it("passes an unrecognized affiliation through as a student rather than dropping it", () => {
    expect(epicPositionLabel("Visiting Scholar")).toBe("Visiting Scholar (Student)");
  });

  it("returns an empty cell for a blank or missing affiliation, never a fabricated one", () => {
    // The previous hardcoded "Yale College (Student)" asserted this about
    // everyone in the batch; a blank cell is honest where the data is absent.
    expect(epicPositionLabel(null)).toBe("");
    expect(epicPositionLabel(undefined)).toBe("");
    expect(epicPositionLabel("")).toBe("");
    expect(epicPositionLabel("   ")).toBe("");
  });
});
