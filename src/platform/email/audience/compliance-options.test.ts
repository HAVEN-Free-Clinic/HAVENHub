import { describe, expect, it } from "vitest";
import { PERSON_FIELDS } from "./person-fields";
import { ALL_COMPLIANCE_STATUSES, complianceStatusLabel } from "@/platform/compliance/labels";

/**
 * The audience builder filters the compliance roster, so it must offer the
 * roster's words. Its option list was written out by hand and had drifted on two
 * of six: "Awaiting verification" where /volunteers says "Needs verification",
 * and "Unknown date" where it says "Date unknown". A campaign author picked one
 * vocabulary and read another.
 */
const complianceField = () => {
  const field = PERSON_FIELDS.find((f) => f.options?.some((o) => o.value === "NO_CERTIFICATE"));
  if (!field) throw new Error("no compliance-status field found in PERSON_FIELDS");
  return field;
};

describe("the audience builder's compliance options", () => {
  it("offers exactly the roster's statuses, in the roster's order", () => {
    expect(complianceField().options?.map((o) => o.value)).toEqual(ALL_COMPLIANCE_STATUSES);
  });

  it("uses the roster's words for every one of them", () => {
    // Fails on PENDING_VERIFICATION and UNKNOWN_DATE against the hand-written list.
    for (const option of complianceField().options ?? []) {
      expect(option.label).toBe(
        complianceStatusLabel(option.value as (typeof ALL_COMPLIANCE_STATUSES)[number], "staff").label,
      );
    }
  });

  it("never shows a raw enum value", () => {
    for (const option of complianceField().options ?? []) {
      expect(option.label).not.toMatch(/^[A-Z][A-Z_]+$/);
    }
  });
});
