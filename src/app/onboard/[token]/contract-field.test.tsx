import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContractField } from "./contract-field";

const ctx = {
  firstName: "Ada", orgName: "HAVEN Free Clinic", todayIso: "2026-07-21",
  trainingDate: "Sunday, May 3", trainingLocation: " in person",
  department: "BVHD", track: "DIRECTOR" as const, epicRequirement: "ALL" as const,
};
const prefill = { firstName: "Ada", lastName: "L", email: "", netId: "", phone: "", yaleAffiliation: "", gradYear: "" };
const noop = () => {};
const noErr = () => undefined;

const html = (block: Parameters<typeof ContractField>[0]["block"]) =>
  renderToStaticMarkup(<ContractField block={block} prefill={prefill} ctx={ctx} err={noErr} onAnswer={noop} />);

describe("ContractField", () => {
  it("renders a section heading and its prose", () => {
    const out = html({ kind: "section", id: "s", title: "Epic Access", body: "**Read** this." });
    expect(out).toContain("Epic Access");
    expect(out).toContain("<strong");
    expect(out).toContain("Read");
  });

  it("renders a checkbox agreement instead of a signature pad", () => {
    const out = html({ kind: "agreement", id: "d", title: "Duties", body: "- one", confirmKind: "checkbox", signatureLabel: "confirm" });
    expect(out).toContain('name="confirm__d"');
    expect(out).not.toContain('name="sig__d"');
    expect(out).toContain("<li>");
  });

  it("interpolates the training date into agreement prose", () => {
    const out = html({ kind: "agreement", id: "t", title: "T", body: "Training is on {{trainingDate}}.", confirmKind: "checkbox", signatureLabel: "confirm" });
    expect(out).toContain("Training is on Sunday, May 3.");
    expect(out).not.toContain("{{trainingDate}}");
  });

  // A signature/initials agreement must keep its editable signature prompt
  // (signatureLabel) visible beside the pad, and must not just repeat the
  // agreement title. Copilot flagged the old render, which passed the title as
  // the pad label so the prompt was dead and the title duplicated.
  it("shows the signature prompt (not a repeated title) for a signature agreement", () => {
    const out = html({ kind: "agreement", id: "s", title: "Volunteer Agreement", body: "You agree.", confirmKind: "signature", signatureLabel: "type your full name" });
    expect(out).toContain('name="sig__s"');
    // title shown once (the heading), prompt shown as the pad label
    expect(out.match(/Volunteer Agreement/g)?.length).toBe(1);
    expect(out).toContain("type your full name");
  });

  it("shows the initials prompt for an initials agreement", () => {
    const out = html({ kind: "agreement", id: "i", title: "Commitment", body: "You commit.", confirmKind: "initials", signatureLabel: "initial below" });
    expect(out).toContain('name="sig__i"');
    expect(out).toContain("initial below");
    expect(out.match(/Commitment/g)?.length).toBe(1);
  });

  it("omits the epicNeeded checkbox entirely", () => {
    expect(html({ kind: "system_field", systemKey: "epic" })).not.toContain('name="epicNeeded"');
  });

  it("hides the access type and expiration until an Epic ID is declared", () => {
    const out = html({ kind: "system_field", systemKey: "epic" });
    expect(out).not.toContain('name="epicAccessType"');
    expect(out).not.toContain('name="existingEpicId"');
  });

  it("renders affiliation as a select carrying every option", () => {
    const out = html({ kind: "system_field", systemKey: "yaleAffiliation" });
    expect(out).toContain('<select name="yaleAffiliation"');
    expect(out).toContain("GSAS");
    expect(out).toContain("YSPH");
  });

  it("renders grad year options from the context year", () => {
    const out = html({ kind: "system_field", systemKey: "gradYear" });
    expect(out).toContain(">2026<");
    expect(out).toContain(">2032<");
  });

  // Addition 1: custom_question labels/helpText pass through FieldPreview as
  // plain text with no {{...}} substitution (FieldPreview is shared with the
  // apply wizard and must stay pure of contract-only concerns). The default
  // director/volunteer layouts author epic_needed_self's label with
  // {{orgName}}, so without interpolation in contract-field.tsx the literal
  // token would leak to signers.
  it("interpolates {{orgName}} into a custom_question label before handing it to FieldPreview", () => {
    const out = html({
      kind: "custom_question", key: "epic_needed_self",
      label: "Is Epic access required for your role at {{orgName}}?",
      type: "SINGLE_SELECT", required: true,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    });
    expect(out).toContain("Is Epic access required for your role at HAVEN Free Clinic?");
    expect(out).not.toContain("{{orgName}}");
  });

  it("interpolates {{orgName}} into a custom_question helpText", () => {
    const out = html({
      kind: "custom_question", key: "q",
      label: "Question", helpText: "Ask {{orgName}} if unsure.",
      type: "SHORT_TEXT", required: false,
    });
    expect(out).toContain("Ask HAVEN Free Clinic if unsure.");
    expect(out).not.toContain("{{orgName}}");
  });

  // systemFieldOptions prepends a stored value the canonical grad-year list
  // does not know (an older applicant, an Airtable import) so the select does
  // not silently drop the applicant's real answer.
  it("keeps and selects a stored gradYear value outside the canonical option list", () => {
    const out = renderToStaticMarkup(
      <ContractField
        block={{ kind: "system_field", systemKey: "gradYear" }}
        prefill={{ ...prefill, gradYear: "2035" }}
        ctx={ctx}
        err={noErr}
        onAnswer={noop}
      />,
    );
    expect(out).toContain(">2035<");
    expect(out).toContain('value="2035" selected');
  });

  // Finding 1 (HIGH): the director default's second_department_name question
  // is a required DEPARTMENT_CHOICE, but ContractField used to hard-code
  // departments={[]} on FieldPreview, so the required <select> rendered with
  // no selectable options at all -- a director who answered "yes" to
  // second_department could never submit. departments must be threaded
  // through from a real caller-supplied list and land as <option>s.
  it("renders selectable options for a DEPARTMENT_CHOICE custom question when departments are supplied", () => {
    const out = renderToStaticMarkup(
      <ContractField
        block={{
          kind: "custom_question", key: "second_department_name",
          label: "If yes, what department will you be volunteering with?",
          type: "DEPARTMENT_CHOICE", required: true,
        }}
        prefill={prefill}
        ctx={ctx}
        err={noErr}
        onAnswer={noop}
        departments={["BVHD", "MDIC"]}
      />,
    );
    expect(out).toContain('<select name="custom__second_department_name"');
    expect(out).toContain('<option value="BVHD">BVHD</option>');
    expect(out).toContain('<option value="MDIC">MDIC</option>');
  });
});
