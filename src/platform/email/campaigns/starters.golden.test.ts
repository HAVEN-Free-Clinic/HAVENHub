/**
 * Golden-render test for the welcome campaign starter. Renders the starter exactly
 * the way the campaign send path does (body resolves `firstName` / `name`; the layout
 * wraps the rendered body and owns the brand color), so a broken `{{#if}}` branch, a
 * stray token, or lost chrome would fail here. Pure (no DB): the body carries no
 * DB-backed variables and the layout default stands in for the (admin-editable) wrapper.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/platform/email/render/render";
import { layoutDescriptor } from "@/platform/email/templates/layout";
import { getStarter } from "./starters";

const BRAND = "#00356b";

function render(ctx: Record<string, unknown>) {
  const welcome = getStarter("welcome")!;
  // Subject is a plain-text header -> rendered without HTML-escaping (mirrors renderInlineEmail).
  const subject = renderTemplate(welcome.subject, ctx, { escape: false });
  const body = renderTemplate(welcome.body, ctx);
  const html = renderTemplate(layoutDescriptor.defaultBody, { brandColor: BRAND, body, subject });
  return { subject, html };
}

describe("welcome starter golden render", () => {
  it("personalizes the greeting + subject when a first name is present", () => {
    const { subject, html } = render({ firstName: "Sam", name: "Sam Rivera" });
    expect(subject).toBe("Welcome to HAVEN Hub, Sam");
    expect(html).toContain("Hi Sam, welcome to HAVEN");
    expect(html).toContain("Welcome aboard,");
    expect(html).toContain("The HAVEN Free Clinic team");
  });

  it("falls back gracefully when there is no first name", () => {
    const { subject, html } = render({ firstName: "", name: "" });
    expect(subject).toBe("Welcome to HAVEN Hub");
    expect(html).toContain("Hi there, welcome to HAVEN");
  });

  it("wraps in the branded layout and leaves no unrendered tokens", () => {
    const { html } = render({ firstName: "Sam", name: "Sam Rivera" });
    // Layout chrome + brand band.
    expect(html).toContain("HAVEN Free Clinic");
    expect(html).toContain(`background-color: ${BRAND}`);
    // Calls to action.
    expect(html).toContain("https://hub.havenfreeclinic.org");
    expect(html).toContain("https://docs.havenfreeclinic.org");
    expect(html).toContain("Browse the docs");
    // Nothing left unresolved.
    expect(html).not.toContain("{{");
  });
});
