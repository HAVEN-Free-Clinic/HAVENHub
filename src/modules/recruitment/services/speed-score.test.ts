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

  return { gradYear, essay, hasCert, certDetail, scorer, application, outsider, outsiderApplication };
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

  it("returns an error for a viewer out of scope", async () => {
    const { outsider, outsiderApplication } = await seed();
    const res = await loadReviewApplication(outsiderApplication.id, outsider.id);
    expect("error" in res).toBe(true);
  });
});
