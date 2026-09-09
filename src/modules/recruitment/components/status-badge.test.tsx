import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CycleStatusBadge, CYCLE_STATUS_LABELS, DECISION_LABELS } from "./status-badge";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("recruitment status vocabulary", () => {
  it("never shows the raw database constant", () => {
    // Five surfaces rendered `{cycle.status}` straight into a Badge, so a
    // recruitment lead read "OPEN" and "ARCHIVED" -- the DB's words, not the
    // product's. SupportStatusBadge states the rule these broke: the label is
    // friendly text, never the enum.
    for (const [value, label] of Object.entries(CYCLE_STATUS_LABELS)) {
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    }
    const out = render(<CycleStatusBadge status="ARCHIVED" />);
    expect(out).toContain("Archived");
    expect(out).not.toContain("ARCHIVED");
  });

  it("labels every cycle status, so no value falls through to the raw enum", () => {
    // The old sites all carried a `?? "default"` / `?? iv.decision` escape
    // hatch, which is how an unlabelled value reached the screen as itself.
    // An exhaustive Record removes the need for one.
    expect(Object.keys(CYCLE_STATUS_LABELS).sort()).toEqual(
      ["ARCHIVED", "CLOSED", "DRAFT", "OPEN"],
    );
  });

  it("keeps the decision wording the three copies already agreed on", () => {
    // Consolidating three identical maps is the point; renaming them on the way
    // through would be an unrequested copy change across three pages.
    expect(DECISION_LABELS).toEqual({
      PENDING: "Pending",
      ACCEPT: "Accepted",
      REJECT: "Rejected",
      WAITLIST: "Waitlisted",
    });
  });
});
