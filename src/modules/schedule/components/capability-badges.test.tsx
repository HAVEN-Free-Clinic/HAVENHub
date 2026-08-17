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

function render(person: { verifiedLanguages: string[]; licensedRN: boolean }): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<CapabilityBadges person={person} />);
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
