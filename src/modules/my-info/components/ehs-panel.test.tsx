import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MyEhsItem } from "@/platform/ehs/services/my-ehs";

// DateOnly resolves the configured display timezone asynchronously, which a
// synchronous static render cannot suspend on. The date itself is not what these
// tests are about.
vi.mock("@/platform/dates/display", () => ({
  DateOnly: ({ value }: { value: Date }) => <span>{value.toISOString().slice(0, 10)}</span>,
}));

const { EhsPanel } = await import("./ehs-panel");

const HEALTH_ON_TRACK =
  "https://healthontrack.yale.edu/s/chs-health-requirement/CHS_Health_Requirement__c/";
const WORKDAY = "https://www.myworkday.com/yale/learning";

const item = (over: Partial<MyEhsItem> = {}): MyEhsItem => ({
  id: "ehs_bbp_student",
  name: "BBP Student",
  description: null,
  complete: false,
  completedAt: null,
  completionUrl: WORKDAY,
  ...over,
});

describe("EhsPanel", () => {
  it("links each outstanding item to the system that actually owns it", () => {
    const out = renderToStaticMarkup(
      <EhsPanel
        items={[
          item(),
          item({
            id: "ehs_hepb_immunity",
            name: "HepB Immunity Assessment",
            completionUrl: HEALTH_ON_TRACK,
          }),
        ]}
      />
    );
    expect(out).toContain(`href="${WORKDAY}"`);
    expect(out).toContain(`href="${HEALTH_ON_TRACK}"`);
    expect(out).toContain("Complete in HealthOnTrack");
    expect(out).toContain("Complete in Workday");
  });

  it("shows the item description, which is where the BBP/HepB relationship is explained", () => {
    const out = renderToStaticMarkup(
      <EhsPanel
        items={[
          item({
            id: "ehs_hepb_immunity",
            name: "HepB Immunity Assessment",
            description: "Part of the Bloodborne Pathogens (BBP) requirement.",
            completionUrl: HEALTH_ON_TRACK,
          }),
        ]}
      />
    );
    expect(out).toContain("Part of the Bloodborne Pathogens (BBP) requirement.");
  });

  it("offers no CTA for an item a coordinator records, which has no link", () => {
    const out = renderToStaticMarkup(
      <EhsPanel items={[item({ id: "ehs_added_to_ehs", name: "Added to EHS?", completionUrl: null })]} />
    );
    expect(out).toContain("Added to EHS?");
    expect(out).not.toContain("Complete in");
    expect(out).not.toContain("<a ");
  });

  it("does not offer a completion link for an item already done", () => {
    const out = renderToStaticMarkup(
      <EhsPanel items={[item({ complete: true, completedAt: new Date("2026-08-01T12:00:00Z") })]} />
    );
    expect(out).not.toContain("Complete in");
  });

  it("gives a compliance manager Mark/Unmark controls instead of member links", () => {
    const toggleAction = vi.fn();
    const manage = { personName: "Casey Volunteer", toggleAction };
    const outstanding = renderToStaticMarkup(<EhsPanel items={[item()]} manage={manage} />);
    expect(outstanding).toContain("Mark complete");
    expect(outstanding).toContain('name="trainingId"');
    expect(outstanding).toContain('value="1"');
    // The manager is not the person who has to go do it, so no external CTA.
    expect(outstanding).not.toContain("Complete in Workday");

    const done = renderToStaticMarkup(
      <EhsPanel items={[item({ complete: true })]} manage={manage} />
    );
    expect(done).toContain("Unmark");
    expect(done).toContain('value="0"');
  });
});
