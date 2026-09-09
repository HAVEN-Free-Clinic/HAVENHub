import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComplianceCells, type ComplianceRowData } from "./compliance-cells";
import { trainingStateLabel, clearanceLabel } from "@/platform/compliance/labels";

/**
 * Every chip in a compliance row reads its words and its tone from
 * platform/compliance/labels. The Training column used to hand-roll its own:
 * grey "Pending" where the training roster one click away says amber "Not yet"
 * for the same state -- and "Pending" in this vocabulary already means
 * outstanding and NOT yours to fix, which is exactly backwards for the one item
 * a lead can clear on the spot.
 */
function row(over: Partial<ComplianceRowData> = {}): ComplianceRowData {
  return {
    person: { id: "p1", name: "Ada Lovelace" } as unknown as ComplianceRowData["person"],
    status: "NO_CERTIFICATE",
    cert: null,
    isVolunteer: true,
    trainingState: "PENDING",
    clearance: {
      onboarded: true,
      cleared: false,
      missing: ["training", "learning"],
      tasks: [
        { key: "training", state: "INCOMPLETE" },
        { key: "learning", state: "INCOMPLETE" },
        { key: "ehs", state: "COMPLETE" },
      ],
    },
    ...over,
  } as ComplianceRowData;
}

const render = (r: ComplianceRowData) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <tr>
          <ComplianceCells row={r} />
        </tr>
      </tbody>
    </table>,
  );

describe("ComplianceCells", () => {
  it("spells an outstanding training the way the training roster does", () => {
    const html = render(row());
    expect(html).toContain(trainingStateLabel("PENDING").label);
    // The word this vocabulary reserves for "not yours to fix".
    expect(html).not.toContain(">Pending<");
  });

  it("carries the training TONE from the shared map, not a local ternary", () => {
    // PENDING is a warning there; the local ternary drew it "default" (grey), so
    // an outstanding training looked like one that did not apply.
    expect(trainingStateLabel("PENDING").tone).toBe("warning");
    const html = render(row());
    expect(html).toContain("warning");
    expect(html).not.toContain(">Pending<");
  });

  it("still says Complete when the training is done", () => {
    expect(render(row({ trainingState: "COMPLETE" }))).toContain(
      trainingStateLabel("COMPLETE").label,
    );
  });

  it("takes the clearance words from clearanceLabel too", () => {
    expect(render(row())).toContain(clearanceLabel("NOT_CLEARED").label);
    const cleared = row();
    cleared.clearance = { onboarded: true, cleared: true, missing: [], tasks: cleared.clearance.tasks };
    expect(render(cleared)).toContain(clearanceLabel("CLEARED").label);
  });

  it("shows a dash, not a status, when training does not apply", () => {
    const html = render(row({ isVolunteer: false }));
    expect(html).not.toContain(trainingStateLabel("PENDING").label);
    expect(html).toContain(">-<");
  });
});
