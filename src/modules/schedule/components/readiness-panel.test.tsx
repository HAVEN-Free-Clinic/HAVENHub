import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadinessPanel } from "./readiness-panel";
import type { BuilderRhd } from "@/modules/schedule/services/builder";
import type { ClinicReadiness } from "@/modules/schedule/engine/rhd";

const readiness: ClinicReadiness = {
  date: "2026-06-06",
  closed: false,
  attendings: [],
  director: null,
  procedures: {
    iudIn: "unknown", iudOut: "unknown", nexplanon: "unknown",
    gac: "unknown", emb: "unknown", seesMale: "unknown",
  },
  coverage: { sctm: 0, jctm: 0, rn: 0, spanish: 0 },
  depoOk: true,
  proceduresBooked: null,
  procedureCapWarning: false,
  emails: [],
};

/** A ClinicDay row, as BuilderRhd carries it. Only the fields the panel reads matter. */
function clinicRow(fields: { directorName?: string | null; proceduresBooked?: number | null }) {
  return {
    id: "cd1",
    termId: "t1",
    clinicDate: new Date(Date.UTC(2026, 5, 6, 12)),
    isClosed: false,
    closedNote: null,
    onCallAttendingId: null,
    specialtyId: null,
    directorName: fields.directorName ?? null,
    proceduresBooked: fields.proceduresBooked ?? null,
  } as BuilderRhd["clinic"];
}

function render(
  rhd: Partial<BuilderRhd>,
  opts: { canManageAttendings?: boolean; profilePersonIds?: Set<string>; editable?: boolean } = {},
) {
  return renderToStaticMarkup(
    <ReadinessPanel
      rhd={{ readiness, clinic: null, directors: [], ...rhd }}
      canManageAttendings={opts.canManageAttendings ?? false}
      profilePersonIds={opts.profilePersonIds ?? new Set()}
      editable={opts.editable ?? true}
      departmentId="d1"
      dateKey="2026-06-06"
      proceduresBookedAction={async () => {}}
    />,
  );
}

describe("ReadinessPanel", () => {
  // The link goes to a page that bounces everyone without the permission, and
  // the nav tab is already dropped for them, so an ungated link here was the one
  // route into a dead end.
  it("offers the Schedule attendings link only to someone who maintains that schedule", () => {
    expect(render({}, { canManageAttendings: true })).toContain("Schedule attendings");
    expect(render({}, { canManageAttendings: false })).not.toContain("Schedule attendings");
  });

  it("shows the directors read off the schedule, not the stored name", () => {
    const out = render({
      directors: [{ id: "p1", name: "Alice Adams" }, { id: "p2", name: "Bob Brown" }],
      clinic: clinicRow({ directorName: "KM" }),
    });
    expect(out).toContain("Alice Adams");
    expect(out).toContain("Bob Brown");
    expect(out).not.toContain("KM");
    // Plural heading when more than one is on.
    expect(out).toContain("Directors");
  });

  it("falls back to the stored name only when nobody is scheduled", () => {
    const out = render({ directors: [], clinic: clinicRow({ directorName: "KM" }) });
    expect(out).toContain("KM");
  });

  it("says nobody is scheduled when there is neither", () => {
    expect(render({})).toContain("Not scheduled");
  });

  it("links a director's name only when the viewer may open their profile", () => {
    const scoped = render(
      { directors: [{ id: "p1", name: "Alice Adams" }] },
      { profilePersonIds: new Set(["p1"]) },
    );
    expect(scoped).toContain("/volunteers/compliance/p1");

    const unscoped = render({ directors: [{ id: "p1", name: "Alice Adams" }] });
    expect(unscoped).toContain("Alice Adams");
    expect(unscoped).not.toContain("/volunteers/compliance/p1");
  });

  it("edits procedures booked inline, seeded from the stored value", () => {
    const out = render({ clinic: clinicRow({ proceduresBooked: 4 }) });
    expect(out).toContain('name="proceduresBooked"');
    expect(out).toContain('value="4"');
    expect(out).toContain('name="dateKey"');
  });

  // An archived term still shows the readout: it is history worth reading even
  // where nothing can be changed.
  it("renders procedures booked read-only on a term that cannot be edited", () => {
    const out = render({ clinic: clinicRow({ proceduresBooked: 4 }) }, { editable: false });
    expect(out).toContain("Procedures booked");
    expect(out).not.toContain('name="proceduresBooked"');
  });

  it("renders the clinic email list as a copyable field when there are addresses", () => {
    const out = render({ readiness: { ...readiness, emails: ["a@yale.edu", "b@yale.edu"] } });
    expect(out).toContain("Clinic emails (all RHD)");
    expect(out).toContain("a@yale.edu, b@yale.edu");
  });
});
