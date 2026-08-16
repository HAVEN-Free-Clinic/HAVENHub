import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhotoCard } from "./photo-card";

/**
 * The `audience` branch is the ONLY consent disclosure in the whole photo
 * feature (see the module doc comment on photo-card.tsx): the notice that
 * tells whoever is looking at the card that the photo came from Yale's
 * directory, not an upload, so the remove control means something. A
 * careless edit here would silently regress consent legibility with nothing
 * to catch it. Follows the renderToStaticMarkup pattern from
 * src/platform/ui/person-photo.test.tsx.
 */
const person = { id: "p1", name: "Ada Lovelace", photoVersion: 3, photoKey: "people/p1" };
const noopRemove = async () => {};
const noopUpload = async (_formData: FormData) => {};

describe("PhotoCard", () => {
  it("discloses the Yale's-directory source, second person, for a Yalies-sourced member view", () => {
    const html = renderToStaticMarkup(
      <PhotoCard
        person={person}
        photoSource="yalies"
        maxMb={4}
        uploadAction={noopUpload}
        removeAction={noopRemove}
      />
    );

    // The disclosure itself, not just the second-person framing around it:
    // without this, deleting "This photo is from Yale's directory." (the
    // actual consent content) would leave "your initials" intact and this
    // test green. See the module doc comment above.
    // renderToStaticMarkup HTML-escapes the apostrophe ("'" -> "&#x27;"), so
    // this is the literal substring that actually appears in the output, not
    // "Yale's directory" verbatim.
    expect(html).toContain("Yale&#x27;s directory");
    expect(html).toContain("your initials");
    expect(html).not.toContain("rather than uploaded");
  });

  it("discloses the same fact, third person, for a Yalies-sourced admin view", () => {
    const html = renderToStaticMarkup(
      <PhotoCard
        person={person}
        photoSource="yalies"
        maxMb={4}
        uploadAction={noopUpload}
        removeAction={noopRemove}
        audience="admin"
      />
    );

    // Same reasoning as the member test above: assert the disclosure itself,
    // not just the third-person framing around it.
    // renderToStaticMarkup HTML-escapes the apostrophe ("'" -> "&#x27;"), so
    // this is the literal substring that actually appears in the output, not
    // "Yale's directory" verbatim.
    expect(html).toContain("Yale&#x27;s directory");
    expect(html).toContain("rather than uploaded");
    expect(html).not.toContain("your initials");
  });

  it("shows no provenance notice for a self-uploaded photo", () => {
    const html = renderToStaticMarkup(
      <PhotoCard
        person={person}
        photoSource="upload"
        maxMb={4}
        uploadAction={noopUpload}
        removeAction={noopRemove}
      />
    );

    expect(html).not.toContain("Yale");
    expect(html).not.toContain("your initials");
    expect(html).not.toContain("rather than uploaded");
  });
});
