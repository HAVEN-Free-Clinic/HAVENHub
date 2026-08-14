/**
 * PersonName: a person's name, with a verified badge when they are cleared.
 *
 * The badge is POSITIVE-ONLY on purpose. Rendering a "not cleared" marker beside
 * a name would publish someone's outstanding HIPAA or training status to every
 * colleague who happens to see their name on a schedule, which is a compliance
 * detail the roster already shows to the people responsible for it. Absence of a
 * badge says nothing.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonName } from "./person-name";

describe("PersonName", () => {
  it("renders the name unchanged when not cleared", () => {
    const out = renderToStaticMarkup(<PersonName name="Ada Lovelace" cleared={false} />);
    expect(out).toContain("Ada Lovelace");
  });

  it("adds no badge, and no marker of any kind, when not cleared", () => {
    // The whole privacy argument for the feature rests on this: an uncleared
    // person must be visually indistinguishable from someone whose clearance was
    // never checked.
    const bare = renderToStaticMarkup(<PersonName name="Ada Lovelace" cleared={false} />);
    const unknown = renderToStaticMarkup(<PersonName name="Ada Lovelace" />);
    expect(bare).toBe(unknown);
    expect(bare).not.toMatch(/svg|title=/i);
  });

  it("adds a badge when cleared", () => {
    const out = renderToStaticMarkup(<PersonName name="Ada Lovelace" cleared />);
    expect(out).toContain("Ada Lovelace");
    expect(out).toMatch(/svg/i);
  });

  it("gives the badge an accessible name, not just a shape", () => {
    // A bare icon is invisible to a screen reader, and the badge's whole job is
    // to convey status. The label must reach assistive tech.
    const out = renderToStaticMarkup(<PersonName name="Ada Lovelace" cleared />);
    expect(out).toMatch(/Cleared/);
  });

  it("falls back to a placeholder rather than rendering an empty element for a nameless person", () => {
    // Person.name is nullable in the schema, and an empty <span> beside a badge
    // reads as a rendering bug.
    const out = renderToStaticMarkup(<PersonName name={null} cleared />);
    expect(out).toContain("Unknown");
  });
});
