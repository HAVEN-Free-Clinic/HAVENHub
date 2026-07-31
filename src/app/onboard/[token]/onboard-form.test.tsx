import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardForm } from "./onboard-form";
import { DIRECTOR_LAYOUT } from "@/modules/recruitment/contract/defaults/director";

const ctx = {
  firstName: "Ada", orgName: "HAVEN Free Clinic", todayIso: "2026-07-21",
  trainingDate: "Sunday, May 3", trainingLocation: " in person",
  department: "BVHD", track: "DIRECTOR" as const, epicRequirement: "ALL" as const,
  storedEpicId: null,
};

describe("OnboardForm", () => {
  // A stored yaleAffiliation of "staff" renders selected in the affiliation
  // <select> via defaultValue (uncontrolled -- no onChange fires on mount).
  // Before the fix, the lifted `answers` state used for visibleWhen
  // evaluation started empty regardless of prefill, so staffTitle's
  // { field: "yaleAffiliation", op: "is", value: "staff" } condition read an
  // unanswered field and hid the block on first render -- silently dropping a
  // required question the applicant never saw. Task 14's server rebuild
  // (from actually-submitted FormData) would compute the same field as
  // visible, so this was a real client/server divergence, not just a client
  // quirk.
  it("shows staffTitle on first render when prefill.yaleAffiliation is staff", () => {
    const prefill = {
      firstName: "Ada", lastName: "L", email: "ada@example.com",
      netId: "abl2", phone: "203-555-0100", yaleAffiliation: "staff", gradYear: "2026",
    };
    const html = renderToStaticMarkup(
      <OnboardForm token="tok" prefill={prefill} layout={DIRECTOR_LAYOUT} ctx={ctx} />,
    );
    expect(html).toContain('name="staffTitle"');
  });

  it("does not show staffTitle when prefill.yaleAffiliation is not staff", () => {
    const prefill = {
      firstName: "Ada", lastName: "L", email: "ada@example.com",
      netId: "abl2", phone: "203-555-0100", yaleAffiliation: "undergrad", gradYear: "2026",
    };
    const html = renderToStaticMarkup(
      <OnboardForm token="tok" prefill={prefill} layout={DIRECTOR_LAYOUT} ctx={ctx} />,
    );
    expect(html).not.toContain('name="staffTitle"');
  });

  // The contract has no draft save, so a reload loses everything typed,
  // including every signature. Until draft save exists the only mitigation is
  // to say so before someone starts. See the audit's B2.
  const basePrefill = {
    firstName: "Ada", lastName: "L", email: "ada@example.com",
    netId: "abl2", phone: "203-555-0100", yaleAffiliation: "undergrad", gradYear: "2026",
  };

  it("warns that nothing is saved until submit", () => {
    const html = renderToStaticMarkup(
      <OnboardForm token="tok" prefill={basePrefill} layout={DIRECTOR_LAYOUT} ctx={ctx} />,
    );
    expect(html).toContain("Nothing is saved until you submit this form.");
  });

  it("tells the volunteer to have the HIPAA PDF ready when the layout asks for one", () => {
    const html = renderToStaticMarkup(
      <OnboardForm token="tok" prefill={basePrefill} layout={DIRECTOR_LAYOUT} ctx={ctx} />,
    );
    expect(html).toContain("Have your HIPAA certificate PDF ready");
  });

  it("omits the certificate sentence when the layout has no HIPAA block", () => {
    // A director can remove the HIPAA block. Telling someone to go fetch a
    // document this form never asks for would be worse than saying nothing.
    const noHipaa = {
      blocks: DIRECTOR_LAYOUT.blocks.filter(
        (b) => !(b.kind === "system_field" && b.systemKey === "hipaa"),
      ),
    };
    const html = renderToStaticMarkup(
      <OnboardForm token="tok" prefill={basePrefill} layout={noHipaa} ctx={ctx} />,
    );
    expect(html).toContain("Nothing is saved until you submit this form.");
    expect(html).not.toContain("HIPAA certificate PDF");
  });
});
