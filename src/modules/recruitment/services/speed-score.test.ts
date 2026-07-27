import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import { addField } from "./form-builder";
import { loadReviewApplication } from "./speed-score";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v-speed", departments: ["SRHD"], acceptsRenewals: false, createdById: lead.id });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });

  const gradYear = await addField(section.id, {
    label: "Grad year", type: "SINGLE_SELECT", required: false,
    options: [{ value: "2027", label: "2027" }],
  });
  const essay = await addField(section.id, { label: "Essay", type: "LONG_TEXT", required: false });
  const hasCert = await addField(section.id, {
    label: "Has cert", type: "SINGLE_SELECT", required: false,
    options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  });
  const certDetail = await addField(section.id, {
    label: "Cert detail", type: "SHORT_TEXT", required: false,
    visibleWhen: { field: hasCert.key, op: "is", value: "yes" },
  });

  const scorer = await prisma.person.create({ data: { name: "Scorer", status: "ACTIVE" } });
  const scoreRole = await prisma.role.create({ data: { name: "Committee Scorer", grants: { create: [{ permission: "recruitment.score" }] } } });
  await prisma.roleAssignment.create({ data: { personId: scorer.id, roleId: scoreRole.id } });

  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ann", lastName: "Lee", email: "ann@yale.edu", emailLower: "ann@yale.edu" } });
  const application = await prisma.application.create({
    data: {
      cycleId: cycle.id,
      applicantId: applicant.id,
      applicantType: "NEW",
      departmentChoices: ["SRHD"],
      answers: {
        [gradYear.key]: "2027",
        [essay.key]: "hello world",
        [hasCert.key]: "no",
        [certDetail.key]: "should be hidden",
      },
    },
  });

  // A second, unrelated cycle/application the outsider has no scope over: no
  // role grants and no department membership, so canViewApplication denies them
  // regardless of routing state.
  const outsiderTerm = await prisma.term.create({ data: { code: "FA26D", name: "Fall 2026 Director", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const outsiderCycle = await prisma.recruitmentCycle.create({
    data: { track: "DIRECTOR", termId: outsiderTerm.id, title: "D", publicSlug: "d-speed", departments: ["MDIC"], createdById: lead.id, status: "OPEN" },
  });
  const outsiderApplicant = await prisma.applicant.create({ data: { cycleId: outsiderCycle.id, firstName: "Zoe", lastName: "Zed", email: "zoe@yale.edu", emailLower: "zoe@yale.edu" } });
  const outsiderApplication = await prisma.application.create({
    data: { cycleId: outsiderCycle.id, applicantId: outsiderApplicant.id, applicantType: "NEW", departmentChoices: ["MDIC"], answers: {} },
  });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });

  return { gradYear, essay, hasCert, certDetail, scorer, application, outsider, outsiderApplication, section };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("loadReviewApplication", () => {
  it("resolves option labels, keeps essays, and enforces access", async () => {
    const { scorer, application } = await seed();
    const res = await loadReviewApplication(application.id, scorer.id);
    expect("view" in res).toBe(true);
    if (!("view" in res)) return;
    const fields = res.view.sections.flatMap((s) => s.fields);
    const gradYear = fields.find((f) => f.key === "grad_year")!;
    expect(gradYear.kind).toBe("scalar");
    expect(gradYear.displayValue).toBe("2027");
    const essay = fields.find((f) => f.key === "essay")!;
    expect(essay.kind).toBe("essay");
    expect(essay.displayValue).toBe("hello world");
  });

  it("drops fields hidden by visibleWhen", async () => {
    const { scorer, application } = await seed();
    const res = await loadReviewApplication(application.id, scorer.id);
    if (!("view" in res)) throw new Error("expected view");
    const keys = res.view.sections.flatMap((s) => s.fields).map((f) => f.key);
    expect(keys).not.toContain("cert_detail"); // has_cert = "no"
  });

  it("shows the hoisted ranking once even when the form has several rank fields", async () => {
    const { scorer, application, section } = await seed();
    // submitApplication hoists the ranking out of the FIRST rank field into its
    // own column, so extra rank fields have nothing of their own to render; each
    // used to repeat the same hoisted list as another identical row.
    await addField(section.id, { label: "Subcommittee ranking", type: "SUBCOMMITTEE_RANK", required: false });
    await addField(section.id, { label: "Subcommittee ranking", type: "SUBCOMMITTEE_RANK", required: false });
    const cqa = await prisma.subcommittee.create({ data: { name: "CQA" } });
    const crec = await prisma.subcommittee.create({ data: { name: "CREC" } });
    await prisma.application.update({
      where: { id: application.id },
      data: { subcommitteeRanking: [cqa.id, crec.id] },
    });

    const res = await loadReviewApplication(application.id, scorer.id);
    if (!("view" in res)) throw new Error("expected view");
    const ranked = res.view.sections
      .flatMap((s) => s.fields)
      .filter((f) => f.label === "Subcommittee ranking");
    expect(ranked).toHaveLength(1);
    expect(ranked[0].displayValue).toBe("1. CQA  ·  2. CREC");
  });

  it("returns an error for a viewer out of scope", async () => {
    const { outsider, outsiderApplication } = await seed();
    const res = await loadReviewApplication(outsiderApplication.id, outsider.id);
    expect("error" in res).toBe(true);
  });

  // #52: a CHECKBOX is persisted as a boolean, which the old condition map dropped,
  // so a question gated on "checkbox is checked" was hidden from the reviewer even
  // though the applicant saw and answered it.
  it("shows a question gated on a checked CHECKBOX (boolean answer normalized)", async () => {
    const { scorer, application, section } = await seed();
    const consent = await addField(section.id, { label: "Consent", type: "CHECKBOX", required: false });
    const followUp = await addField(section.id, {
      label: "Consent detail", type: "SHORT_TEXT", required: false,
      visibleWhen: { field: consent.key, op: "is", value: "on" },
    });
    await prisma.application.update({
      where: { id: application.id },
      // CHECKBOX stored as a boolean (z.coerce.boolean at submit time).
      data: { answers: { [consent.key]: true, [followUp.key]: "the detail" } },
    });

    const res = await loadReviewApplication(application.id, scorer.id);
    if (!("view" in res)) throw new Error("expected view");
    const detail = res.view.sections.flatMap((s) => s.fields).find((f) => f.key === followUp.key);
    expect(detail?.displayValue).toBe("the detail");
  });

  // #53/#54: a RENEWAL never submits the DEPARTMENT_CHOICE field (the department comes
  // from renewalDepartment -> departmentChoices), so a department-gated question was
  // evaluated against an empty value and dropped from the reviewer's view.
  it("shows a department-gated question for a renewal whose department lives in departmentChoices", async () => {
    const term = await prisma.term.create({ data: { code: "SP27", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    const lead = await prisma.person.create({ data: { name: "Lead2", status: "ACTIVE" } });
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V2", publicSlug: "v2-speed", departments: ["SRHD", "MDIC"], acceptsRenewals: true, createdById: lead.id });
    const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
    const deptField = await addField(section.id, { label: "Department", type: "DEPARTMENT_CHOICE", required: true });
    const srhdQ = await addField(section.id, {
      label: "SRHD-only question", type: "SHORT_TEXT", required: false,
      visibleWhen: { field: deptField.key, op: "isAnyOf", value: ["SRHD"] },
    });

    const scorer = await prisma.person.create({ data: { name: "Scorer2", status: "ACTIVE" } });
    const role = await prisma.role.create({ data: { name: "Scorer2 role", grants: { create: [{ permission: "recruitment.score" }] } } });
    await prisma.roleAssignment.create({ data: { personId: scorer.id, roleId: role.id } });

    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Reed", lastName: "R", email: "reed@yale.edu", emailLower: "reed@yale.edu" } });
    const application = await prisma.application.create({
      data: {
        cycleId: cycle.id, applicantId: applicant.id, applicantType: "RENEWAL",
        departmentChoices: ["SRHD"], // the renewal department; the dept-choice field key is NOT in answers
        answers: { [srhdQ.key]: "my renewal answer" },
      },
    });

    const res = await loadReviewApplication(application.id, scorer.id);
    if (!("view" in res)) throw new Error("expected view");
    const shown = res.view.sections.flatMap((s) => s.fields).find((f) => f.key === srhdQ.key);
    expect(shown?.displayValue).toBe("my renewal answer");
  });
});
