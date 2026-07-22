import { describe, it, expect } from "vitest";
import { buildContractReview, reconstructContractAnswers } from "./review";
import type { ContractLayout } from "./layout";
import type { ContractContext } from "./visibility";

const ctx: ContractContext = { department: "IM", track: "VOLUNTEER", epicRequirement: "SOME" };

/** A stored submitted contract with every field defaulted to "not provided",
 *  so each test overrides only what it exercises. */
function contract(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Emma",
    lastName: "Stone",
    email: "emma@yale.edu",
    netId: null,
    phone: null,
    dateOfBirth: null,
    dietaryRestrictions: null,
    yaleAffiliation: null,
    gradYear: null,
    pronouns: null,
    staffTitle: null,
    epicIdExpiration: null,
    hasEpic: false,
    existingEpicId: null,
    epicAccessType: null,
    worksWithYnhh: false,
    spanishSelfReported: false,
    licensedRN: false,
    hipaaCompletedAt: null,
    hipaaFileName: null,
    hipaaStoredName: null,
    customAnswers: {},
    signatures: {},
    agreementSignature: null,
    professionalismSignature: null,
    trainingSignature: null,
    initials: null,
    ...overrides,
  };
}

describe("reconstructContractAnswers", () => {
  it("rebuilds the applicant answers map from stored columns + custom answers", () => {
    const ans = reconstructContractAnswers(
      contract({
        yaleAffiliation: "staff",
        gradYear: "2027",
        hasEpic: true,
        customAnswers: { second_department: "PEDS" },
      }),
    );
    expect(ans).toMatchObject({
      firstName: "Emma",
      lastName: "Stone",
      email: "emma@yale.edu",
      yaleAffiliation: "staff",
      gradYear: "2027",
      second_department: "PEDS",
      hasEpic: "on",
    });
  });

  it("represents a missing Epic as an empty hasEpic string (matching the submit path)", () => {
    expect(reconstructContractAnswers(contract({ hasEpic: false })).hasEpic).toBe("");
  });
});

describe("buildContractReview responses", () => {
  it("renders system fields with resolved labels and select values", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "name" },
        { kind: "system_field", systemKey: "email" },
        { kind: "system_field", systemKey: "yaleAffiliation" },
        { kind: "system_field", systemKey: "spanish" },
      ],
    };
    const r = buildContractReview(
      contract({ yaleAffiliation: "som", spanishSelfReported: true }),
      layout,
      ctx,
    );
    expect(r.responses).toEqual([
      { label: "Name", value: "Emma Stone" },
      { label: "Email", value: "emma@yale.edu" },
      { label: "Yale affiliation", value: "Yale School of Management (SOM)" },
      { label: "I can speak Spanish with patients", value: "Yes" },
    ]);
  });

  it("shows an optional field the applicant left blank as a null value", () => {
    const layout: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "dietary" }] };
    const r = buildContractReview(contract({ dietaryRestrictions: null }), layout, ctx);
    expect(r.responses).toEqual([{ label: "Dietary restrictions", value: null }]);
  });

  it("expands the Epic block when the applicant has an Epic ID", () => {
    const layout: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "epic" }] };
    const r = buildContractReview(
      contract({ hasEpic: true, existingEpicId: "ABC123", epicAccessType: "renewal", worksWithYnhh: true }),
      layout,
      ctx,
    );
    expect(r.responses).toEqual([
      { label: "Has Epic ID", value: "Yes" },
      { label: "Existing Epic ID", value: "ABC123" },
      { label: "Epic access type", value: "Renewal or reactivation" },
      { label: "Works with Yale New Haven Hospital", value: "Yes" },
    ]);
  });

  it("collapses the Epic block to the two booleans when the applicant has no Epic ID", () => {
    const layout: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "epic" }] };
    const r = buildContractReview(contract({ hasEpic: false }), layout, ctx);
    expect(r.responses).toEqual([
      { label: "Has Epic ID", value: "No" },
      { label: "Works with Yale New Haven Hospital", value: "No" },
    ]);
  });

  it("renders the HIPAA completion date and flags the certificate row for download", () => {
    const layout: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "hipaa" }] };
    const r = buildContractReview(
      contract({
        hipaaCompletedAt: new Date(Date.UTC(2026, 5, 1, 12)),
        hipaaFileName: "cert.pdf",
        hipaaStoredName: "hipaa-uuid.pdf",
      }),
      layout,
      ctx,
    );
    expect(r.responses).toEqual([
      { label: "HIPAA completion date", value: "Jun 1, 2026" },
      { label: "HIPAA certificate", value: "cert.pdf", cert: { fileName: "cert.pdf" } },
    ]);
  });

  it("resolves custom-question select answers to their option labels", () => {
    const layout: ContractLayout = {
      blocks: [
        {
          kind: "custom_question",
          key: "tshirt",
          label: "T-shirt size",
          type: "SINGLE_SELECT",
          required: false,
          options: [
            { value: "s", label: "Small" },
            { value: "m", label: "Medium" },
          ],
        },
        {
          kind: "custom_question",
          key: "langs",
          label: "Languages",
          type: "MULTI_SELECT",
          required: false,
          options: [
            { value: "es", label: "Spanish" },
            { value: "fr", label: "French" },
          ],
        },
      ],
    };
    const r = buildContractReview(contract({ customAnswers: { tshirt: "m", langs: ["es", "fr"] } }), layout, ctx);
    expect(r.responses).toEqual([
      { label: "T-shirt size", value: "Medium" },
      { label: "Languages", value: "Spanish, French" },
    ]);
  });

  it("omits section blocks (the summary carries answers, not prose)", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "section", id: "intro", title: "Welcome", body: "Hello there" },
        { kind: "system_field", systemKey: "email" },
      ],
    };
    const r = buildContractReview(contract(), layout, ctx);
    expect(r.responses.map((f) => f.label)).toEqual(["Email"]);
  });

  it("omits a disabled optional system field", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "email" },
        { kind: "system_field", systemKey: "netId", enabled: false },
      ],
    };
    const r = buildContractReview(contract({ netId: "es123" }), layout, ctx);
    expect(r.responses.map((f) => f.label)).toEqual(["Email"]);
  });

  it("hides a block whose visibleWhen fails and shows it when it passes", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "yaleAffiliation" },
        {
          kind: "system_field",
          systemKey: "staffTitle",
          visibleWhen: { field: "yaleAffiliation", op: "is", value: "staff" },
        },
      ],
    };
    const hidden = buildContractReview(contract({ yaleAffiliation: "som" }), layout, ctx);
    expect(hidden.responses.map((f) => f.label)).toEqual(["Yale affiliation"]);

    const shown = buildContractReview(
      contract({ yaleAffiliation: "staff", staffTitle: "Program Coordinator" }),
      layout,
      ctx,
    );
    expect(shown.responses.map((f) => f.label)).toEqual([
      "Yale affiliation",
      "If you are a staff member, please list your official employee title and office or department",
    ]);
    expect(shown.responses[1].value).toBe("Program Coordinator");
  });
});

describe("buildContractReview agreements and signatures", () => {
  const layout: ContractLayout = {
    blocks: [
      { kind: "agreement", id: "confid", title: "Confidentiality", body: "", signatureLabel: "Sign", confirmKind: "signature" },
      { kind: "agreement", id: "prof", title: "Professionalism", body: "", signatureLabel: "I agree", confirmKind: "checkbox" },
      { kind: "agreement", id: "unsig", title: "Unsigned one", body: "", signatureLabel: "Sign", confirmKind: "signature" },
      { kind: "system_field", systemKey: "initials" },
    ],
  };

  it("reports each agreement's confirmation status by kind", () => {
    const r = buildContractReview(
      contract({
        signatures: {
          confid: { method: "draw", name: "Emma Stone", imageKey: "onboarding/1/sig-confid.png", signedAt: "2026-07-22T12:00:00Z" },
          initials: { method: "type", name: "ES", imageKey: "onboarding/1/sig-initials.png", signedAt: "2026-07-22T12:00:00Z" },
        },
        customAnswers: { confirm__prof: "on" },
      }),
      layout,
      ctx,
    );
    expect(r.agreements).toEqual([
      { blockId: "confid", title: "Confidentiality", confirmKind: "signature", confirmed: true },
      { blockId: "prof", title: "Professionalism", confirmKind: "checkbox", confirmed: true },
      { blockId: "unsig", title: "Unsigned one", confirmKind: "signature", confirmed: false },
    ]);
  });

  it("returns signature rows only for signable blocks, excluding checkbox agreements", () => {
    const r = buildContractReview(
      contract({
        signatures: {
          confid: { method: "draw", name: "Emma Stone", imageKey: "onboarding/1/sig-confid.png", signedAt: "2026-07-22T12:00:00Z" },
          initials: { method: "type", name: "ES", imageKey: "onboarding/1/sig-initials.png", signedAt: "2026-07-22T12:00:00Z" },
        },
        customAnswers: { confirm__prof: "on" },
      }),
      layout,
      ctx,
    );
    expect(r.signatureRows.map((s) => s.blockId)).toEqual(["confid", "unsig", "initials"]);
  });
});
