import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StrikesPanel } from "./strikes-panel";
import type { MyStrike } from "@/modules/incidents/services/disciplinary";

/**
 * This panel is the only place a volunteer can see their own disciplinary
 * record. Under a three-strikes policy the count and the position in the
 * sequence are the load-bearing facts, so both are pinned here.
 *
 * Redaction is upstream in subjectFacingDetail (covered in disciplinary.test.ts);
 * this file only checks that whatever it produced is displayed faithfully and
 * that nothing else leaks in.
 */

function strike(over: Partial<MyStrike> = {}): MyStrike {
  return {
    id: "a1",
    occurredAt: new Date("2026-04-01T12:00:00Z"),
    category: "Attendance",
    detail: "Missed a shift without notice.",
    ordinal: 1,
    ...over,
  };
}

describe("StrikesPanel", () => {
  // Rendering nothing would leave a member unsure whether they have a clean
  // record or the section failed to load.
  it("states a clean record outright rather than rendering an empty section", () => {
    const html = renderToStaticMarkup(<StrikesPanel strikes={[]} />);
    expect(html).toContain("no disciplinary actions on file");
  });

  it("shows the total count", () => {
    const html = renderToStaticMarkup(
      <StrikesPanel strikes={[strike({ id: "a1", ordinal: 1 }), strike({ id: "a2", ordinal: 2 })]} />,
    );
    expect(html).toContain("2");
    expect(html).toContain("strikes on file");
  });

  it("singularises the count for one strike", () => {
    const html = renderToStaticMarkup(<StrikesPanel strikes={[strike()]} />);
    expect(html).toContain("strike on file");
    expect(html).not.toContain("strikes on file");
  });

  // The ordinal is the answer to "is this my second or my third?", which the
  // ledger's running-total column never told anyone.
  it("labels each strike with its position in the sequence", () => {
    const html = renderToStaticMarkup(
      <StrikesPanel
        strikes={[
          strike({ id: "a1", ordinal: 1 }),
          strike({ id: "a2", ordinal: 2 }),
          strike({ id: "a3", ordinal: 3 }),
        ]}
      />,
    );
    expect(html).toContain("1st strike");
    expect(html).toContain("2nd strike");
    expect(html).toContain("3rd strike");
  });

  it("falls back to a plain ordinal past the third", () => {
    const html = renderToStaticMarkup(<StrikesPanel strikes={[strike({ ordinal: 4 })]} />);
    expect(html).toContain("4th strike");
  });

  it("renders the category and the subject-facing detail", () => {
    const html = renderToStaticMarkup(
      <StrikesPanel strikes={[strike({ category: "Patient Safety", detail: "Left before handoff." })]} />,
    );
    expect(html).toContain("Patient Safety");
    expect(html).toContain("Left before handoff.");
  });

  // A confidential strike arrives here with detail already replaced by the
  // pointer-to-a-human text. The panel must not add a heading or placeholder
  // that implies the missing narrative is retrievable from this page.
  it("renders the redacted detail as-is for a confidential strike", () => {
    const redacted = "Contact your department directors or the HAVEN Executive Directors for the details of this decision.";
    const html = renderToStaticMarkup(<StrikesPanel strikes={[strike({ detail: redacted })]} />);
    expect(html).toContain("Contact your department directors");
  });

  it("omits the detail paragraph entirely when there is no detail to show", () => {
    const html = renderToStaticMarkup(<StrikesPanel strikes={[strike({ detail: "" })]} />);
    expect(html).toContain("Attendance");
    expect(html).toContain("1st strike");
  });

  it("points the member at a human for questions", () => {
    const html = renderToStaticMarkup(<StrikesPanel strikes={[strike()]} />);
    expect(html).toContain("Executive Directors");
  });

  // occurredAt is a calendar-day marker anchored at noon UTC. Rendering it with
  // the zone-aware DateOnly would show an ET member "March 31" for a strike the
  // ledger and their notification email both call April 1. The member's view
  // disagreeing with the record their director reads is the whole problem this
  // panel exists to solve, so the formatting has to match.
  it("renders the date as a UTC calendar day, matching the ledger and the email", () => {
    const html = renderToStaticMarkup(
      <StrikesPanel strikes={[strike({ occurredAt: new Date("2026-04-01T12:00:00Z") })]} />,
    );
    expect(html).toContain("April 1, 2026");
  });

  // The trap this guards: a midnight-UTC value is still April 1 as a calendar
  // marker, but is March 31 in every US zone.
  it("does not shift a midnight-UTC date backwards into the previous day", () => {
    const html = renderToStaticMarkup(
      <StrikesPanel strikes={[strike({ occurredAt: new Date("2026-04-01T00:00:00Z") })]} />,
    );
    expect(html).toContain("April 1, 2026");
    expect(html).not.toContain("March 31");
  });
});
