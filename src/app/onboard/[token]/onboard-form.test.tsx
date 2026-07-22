import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardForm } from "./onboard-form";
import { DIRECTOR_LAYOUT } from "@/modules/recruitment/contract/defaults/director";

const ctx = {
  firstName: "Ada", orgName: "HAVEN Free Clinic", todayIso: "2026-07-21", currentYear: 2026,
  trainingDate: "Sunday, May 3", trainingLocation: " in person",
  department: "BVHD", track: "DIRECTOR" as const, epicRequirement: "ALL" as const,
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
});
