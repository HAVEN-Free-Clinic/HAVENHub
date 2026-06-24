import * as fs from "fs";
import * as path from "path";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { generatePdf } from "./itcm-pdf";

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

async function loadOutput() {
  const bytes = await generatePdf({
    requestType: "new_individual",
    authorizerKey: "CC",
    person,
    endDate: "10/15/2026",
    mirrorPerson: { name: "Mirror Person", epicId: "MIR456" },
    templateBytes,
  });
  return PDFDocument.load(bytes);
}

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
    expect(form.getTextField("Text1").getText()).toBe("Caprice Culkin");
    expect(form.getTextField("Text12").getText()).toBe("Jane");
    expect(form.getTextField("Text18").getText()).toBe("Doe");
    expect(form.getTextField("Text78").getText()).toBe("Mirror Person");
  });
});
