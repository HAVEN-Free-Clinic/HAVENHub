import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingTable } from "./onboarding-table";
import type { OnboardingRow } from "@/modules/recruitment/engine/onboarding-rows";

const noop = () => {};

function row(over: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    acceptanceId: "a1", contractId: "c1", firstName: "Ona", lastName: "Boarder",
    departmentCode: "SRHD", state: "SUBMITTED", onRoster: false, customAnswers: [],
    ...over,
  };
}

const html = (rows: OnboardingRow[]) =>
  renderToStaticMarkup(
    <OnboardingTable rows={rows} cycleId="cy1" sendLinks={noop} promote={noop} withdraw={noop} />,
  );

describe("OnboardingTable", () => {
  it("renders a checkbox for a selectable row", () => {
    expect(html([row({ state: "SUBMITTED" })])).toContain('name="acceptanceId"');
  });

  it("renders no checkbox for a conflicted row", () => {
    const out = html([row({ state: "CONFLICT" })]);
    expect(out).not.toContain('name="acceptanceId"');
    expect(out).toContain("Conflict");
  });

  it("renders no checkbox for a promoted row", () => {
    expect(html([row({ state: "PROMOTED" })])).not.toContain('name="acceptanceId"');
  });

  it("labels an expired link distinctly from a live one", () => {
    expect(html([row({ state: "EXPIRED" })])).toContain("Expired");
    expect(html([row({ state: "SENT" })])).toContain("Sent");
  });

  it("links to the contract review for a submitted row", () => {
    expect(html([row({ state: "SUBMITTED", contractId: "c9" })]))
      .toContain("/recruitment/cycles/cy1/onboarding/c9");
  });

  it("shows an on-roster marker once promoted", () => {
    expect(html([row({ state: "PROMOTED", onRoster: true })])).toContain("on roster");
  });

  it("renders resolved custom answers", () => {
    const out = html([row({ customAnswers: [{ label: "T-shirt size", value: "M" }] })]);
    expect(out).toContain("T-shirt size");
    expect(out).toContain("M");
  });

  it("offers only departments present in the rows", () => {
    const out = html([row({ departmentCode: "SRHD" }), row({ acceptanceId: "a2", departmentCode: "PCAR" })]);
    expect(out).toContain('value="SRHD"');
    expect(out).toContain('value="PCAR"');
    expect(out).not.toContain('value="BVHD"');
  });

  it("renders an empty state when there are no acceptances", () => {
    expect(html([])).toContain("No accepted applicants yet.");
  });

  // The per-row Withdraw is how you deal with one person without touching the
  // selection. It carries its own id so it cannot act on whatever is checked.
  it("renders a per-row withdraw carrying only that row's id", () => {
    const out = html([row({ state: "SUBMITTED", acceptanceId: "a7" })]);
    expect(out).toContain('name="onlyAcceptanceId"');
    expect(out).toContain('value="a7"');
  });

  it("renders no per-row withdraw for a row with no contract", () => {
    expect(html([row({ state: "NO_CONTRACT", contractId: null })])).not.toContain('name="onlyAcceptanceId"');
  });

  it("renders no per-row withdraw for a promoted row", () => {
    expect(html([row({ state: "PROMOTED" })])).not.toContain('name="onlyAcceptanceId"');
  });

  // Nothing is selected on first render, so the bulk actions all start at zero.
  it("starts every bulk action at a zero count", () => {
    const out = html([row({ state: "SUBMITTED" })]);
    expect(out).toContain("Send links (0)");
    expect(out).toContain("Promote (0)");
    expect(out).toContain("Withdraw (0)");
  });
});
