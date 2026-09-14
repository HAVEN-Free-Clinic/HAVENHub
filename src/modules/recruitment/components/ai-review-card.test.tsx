import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AiReviewCard } from "./ai-review-card";
import type { AiReviewView } from "@/modules/recruitment/services/ai-review";

const review: AiReviewView = {
  applicationId: "app1",
  runLabel: "FA26 advisory v2",
  score: 4,
  rank: 107,
  merit: 34,
  engagement: 4,
  skills: 5,
  effort: 3,
  reliability: 4,
  firstChoiceDepartmentCode: "PHLO",
  firstChoiceFit: 2,
  bestFitDepartmentCode: "MEDS",
  justification: "Pharmacy technician with medication-access work.",
  flags: ["licensed_professional", "needs_human_read"],
  overrideNote: null,
  updatedAt: new Date("2026-09-14T15:00:00Z"),
};

const names = { MEDS: "Medication Access", PHLO: "Phlebotomy" };

describe("AiReviewCard", () => {
  it("suggests re-routing an unrouted applicant away from a first choice that does not fit", () => {
    const html = renderToStaticMarkup(
      <AiReviewCard review={review} committeeAverage={2} routedDepartmentCode={null} departmentChoices={["PHLO"]} departmentNames={names} />,
    );
    expect(html).toContain("Suggests re-routing to Medication Access (MEDS)");
    expect(html).toContain("First choice is Phlebotomy (PHLO).");
    expect(html).toContain("Fit there: 2/5.");
    expect(html).toContain("Committee 2.0 avg, -2.0 against the AI");
    expect(html).toContain("Big gap");
  });

  it("stops suggesting once the lead has routed them to the best fit", () => {
    const html = renderToStaticMarkup(
      <AiReviewCard review={review} committeeAverage={null} routedDepartmentCode="MEDS" departmentChoices={["PHLO"]} departmentNames={names} />,
    );
    expect(html).not.toContain("Suggests re-routing");
    expect(html).toContain("Best fit:");
    expect(html).toContain("No committee score to compare yet.");
  });

  it("names flags in words, never their keys, and shows every dimension", () => {
    const html = renderToStaticMarkup(
      <AiReviewCard review={review} committeeAverage={4} routedDepartmentCode={null} departmentChoices={["MEDS"]} departmentNames={names} />,
    );
    expect(html).toContain("Licensed professional");
    expect(html).toContain("Needs a human read");
    expect(html).not.toContain("needs_human_read");
    for (const label of ["Safety-net engagement", "Skills", "Application effort", "Availability"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("Big gap");
  });

  it("explains an override", () => {
    const html = renderToStaticMarkup(
      <AiReviewCard review={{ ...review, score: 1, overrideNote: "job-application template" }} committeeAverage={null} routedDepartmentCode={null} departmentChoices={["MEDS"]} departmentNames={names} />,
    );
    expect(html).toContain("Scored 1 regardless of rank: job-application template");
  });
});
