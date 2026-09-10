/**
 * This is an extraction with no red-before-green test available: the six
 * `if (counts.X > 0)` blocks it replaces were inline JSX inside
 * /volunteers/page.tsx, an async DB-backed server page that
 * renderToStaticMarkup cannot render. The wording fix (EXPIRING_SOON was
 * written "expiring") is guarded by the diff.
 *
 * What these assertions do buy: the first one asserts the DERIVATION rather
 * than the six literal strings, so it fails if someone re-types a word here
 * instead of taking it from complianceStatusLabel -- which is exactly how the
 * second vocabulary appeared the first time.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALL_COMPLIANCE_STATUSES,
  complianceStatusLabel,
} from "@/platform/compliance/labels";
import { BADGE_TONE_CLASSES } from "@/platform/ui/badge";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { StatusCountChips } from "./status-count-chips";

function counts(fill: number, overrides: Partial<Record<ComplianceStatus, number>> = {}) {
  const base = Object.fromEntries(
    ALL_COMPLIANCE_STATUSES.map((s) => [s, fill]),
  ) as Record<ComplianceStatus, number>;
  return { ...base, ...overrides };
}

describe("StatusCountChips", () => {
  it("takes every word from the shared staff label rather than re-typing it", () => {
    const out = renderToStaticMarkup(<StatusCountChips counts={counts(3)} />);
    for (const s of ALL_COMPLIANCE_STATUSES) {
      expect(out).toContain(`3 ${complianceStatusLabel(s, "staff").label.toLowerCase()}`);
    }
    // The specific drift this closes: the page said "expiring" while the badge
    // in the table below it said "Expiring soon" for the same people.
    expect(out).toContain("3 expiring soon");
  });

  it("hides the categories nobody has, because this row repeats per department", () => {
    const out = renderToStaticMarkup(
      <StatusCountChips counts={counts(0, { EXPIRED: 2 })} />,
    );
    expect(out).toContain("2 expired");
    expect(out).not.toContain("compliant");
    expect(out).not.toContain("no certificate");
  });

  it("wires each word to its own status's tone", () => {
    const out = renderToStaticMarkup(<StatusCountChips counts={counts(1)} />);
    for (const s of ALL_COMPLIANCE_STATUSES) {
      const { label, tone } = complianceStatusLabel(s, "staff");
      // The chip carrying this word must carry this status's tone class.
      const chip = out
        .split("<span")
        .find((frag) => frag.includes(`1 ${label.toLowerCase()}`));
      expect(chip, `no chip rendered for ${s}`).toBeDefined();
      expect(chip).toContain(BADGE_TONE_CLASSES[tone]);
    }
  });
});
