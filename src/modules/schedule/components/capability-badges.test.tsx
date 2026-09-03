// @vitest-environment jsdom
/**
 * Audit 14 (A11Y-8): the verified-language badge on the Full Schedule showed a bare
 * ISO code ("ES") and carried its actual meaning only in a `title` attribute. `title`
 * is a hover tooltip: there is no keyboard path to it, and on a plain <span> it is not
 * part of the accessible name for most screen readers. So the one thing this badge
 * exists to say -- who can interpret for this patient -- reached mouse users and
 * nobody else, on the page the clinic consults mid-shift.
 *
 * Renders to HTML and asserts on the accessible text, so a future edit that drops the
 * visually-hidden label back into a tooltip fails here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilityBadges } from "./capability-badges";

function render(
  person: { verifiedLanguages: string[]; licensedRN: boolean; spanishScore?: number | null },
  department?: { minInterpreterScore: number | null } | null,
): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <CapabilityBadges person={person} department={department} />,
  );
  return host;
}

/** Text an assistive technology would read: everything not marked aria-hidden. */
function accessibleText(host: HTMLElement): string {
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[aria-hidden]").forEach((el) => el.remove());
  return clone.textContent ?? "";
}

describe("CapabilityBadges verified-language badge", () => {
  it("names the language in text, not only in a title tooltip", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false });
    expect(accessibleText(host)).toContain("Verified: Spanish");
  });

  it("still shows the short code to sighted users", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false });
    expect(host.textContent).toContain("ES");
  });

  it("hides the code from assistive tech, so it is not spelled out before the name", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false });
    expect(accessibleText(host)).not.toContain("ES");
  });

  it("keeps the tooltip for the sighted mouse user it does serve", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false });
    expect(host.querySelector("[title]")?.getAttribute("title")).toBe("Verified: Spanish");
  });

  it("names every verified language when a person has several", () => {
    const host = render({ verifiedLanguages: ["es", "ht"], licensedRN: false });
    const text = accessibleText(host);
    expect(text).toContain("Verified: Spanish");
    expect(text).toContain("Verified: Haitian Creole");
  });

  it("renders nothing when the person has no verified capability", () => {
    const host = render({ verifiedLanguages: [], licensedRN: false });
    expect(host.textContent).toBe("");
  });

  it("still renders the RN badge alongside languages", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: true });
    expect(host.textContent).toContain("RN");
  });
});

/**
 * The per-department interpreting bar.
 *
 * 4 clinic-wide; departments that staff conversational speakers set 3. The badge
 * is what tells a director standing in clinic that the person they are about to
 * ask to interpret is below THEIR department's bar, because nothing refuses the
 * assignment.
 */
describe("CapabilityBadges Spanish proficiency bar", () => {
  it("reads as a plain verified badge when the score clears the clinic-wide bar", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 4 });
    expect(accessibleText(host)).toBe("Verified: Spanish");
  });

  it("says so, in text, when the score is below the bar", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 2 });
    const text = accessibleText(host);
    expect(text).toContain("assessed 2");
    expect(text).toContain("below this department's bar of 4");
  });

  it("respects a department that accepts conversational speakers", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 3 },
      { minInterpreterScore: 3 },
    );
    expect(accessibleText(host)).toBe("Verified: Spanish");
  });

  it("still flags a score below even that department's lower bar", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 2 },
      { minInterpreterScore: 3 },
    );
    expect(accessibleText(host)).toContain("below this department's bar of 3");
  });

  it("falls back to the clinic-wide bar when the department sets none", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 3 },
      { minInterpreterScore: null },
    );
    expect(accessibleText(host)).toContain("below this department's bar of 4");
  });

  // INTP verified people for years without always recording a number. Treating
  // "no score" as a shortfall would decorate most of the historical roster with
  // a warning that means nothing.
  it("does not flag an unscored speaker", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: null });
    expect(accessibleText(host)).toBe("Verified: Spanish");
  });

  it("never flags a language that carries no score", () => {
    const host = render(
      { verifiedLanguages: ["ht"], licensedRN: false, spanishScore: 1 },
      { minInterpreterScore: 5 },
    );
    expect(accessibleText(host)).toBe("Verified: Haitian Creole");
  });

  it("keeps the shortfall out of the visible chip's accessible duplicate", () => {
    // The code+score chip is aria-hidden; the sentence is the accessible name.
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 2 });
    expect(host.textContent).toContain("ES 2");
    expect(accessibleText(host)).not.toContain("ES 2");
  });

  it("marks the top of the scale with a plus", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 5 });
    expect(host.textContent).toContain("ES+");
  });

  it("names the level in the accessible text for a top scorer", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 5 });
    expect(accessibleText(host)).toContain("Verified: Spanish, assessed 5 (Native)");
  });

  it("shows a plain code for a 4, which is fluent but not native", () => {
    const host = render({ verifiedLanguages: ["es"], licensedRN: false, spanishScore: 4 });
    expect(host.textContent).toContain("ES");
    expect(host.textContent).not.toContain("ES+");
  });

  it("shows a plain code for a 3 where the department accepts it", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 3 },
      { minInterpreterScore: 3 },
    );
    expect(host.textContent).toContain("ES");
    expect(host.textContent).not.toContain("ES+");
  });

  // A below-bar speaker shows the exact number and never the plus. The two
  // cannot collide for any sane bar: being below bar forces score < bar <= 5,
  // so a below-bar speaker is never a 5. The !flagged guard in the component
  // is unreachable through the app: validateInterpreterBar (departments.ts)
  // rejects anything outside 1-5 on both the create and update paths, the
  // only writers of minInterpreterScore. It only covers a bar written
  // directly to Postgres by hand, bypassing that service.
  it("shows the number, not the plus, for a speaker below the bar", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 3 },
      { minInterpreterScore: 4 },
    );
    expect(host.textContent).toContain("ES 3");
    expect(host.textContent).not.toContain("ES+");
  });

  it("still shows the plus when the department bar is exactly the top score", () => {
    const host = render(
      { verifiedLanguages: ["es"], licensedRN: false, spanishScore: 5 },
      { minInterpreterScore: 5 },
    );
    expect(host.textContent).toContain("ES+");
  });

  it("leaves a non-Spanish language unmarked at any score", () => {
    const host = render({ verifiedLanguages: ["ht"], licensedRN: false, spanishScore: 5 });
    expect(host.textContent).toContain("HT");
    expect(host.textContent).not.toContain("HT+");
  });
});
