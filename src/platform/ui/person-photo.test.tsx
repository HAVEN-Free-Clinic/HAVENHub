import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonPhoto } from "./person-photo";
import { photoUrl } from "@/platform/photos/shared";

const person = { id: "p1", name: "Ada Lovelace", photoVersion: 3 };

describe("PersonPhoto", () => {
  it("points the img src at exactly what photoUrl produces", () => {
    const out = renderToStaticMarkup(<PersonPhoto person={person} size={32} />);
    expect(out).toContain(`src="${photoUrl(person)}"`);
  });

  it("renders a single img and nothing else, with no conditional fallback markup", () => {
    const out = renderToStaticMarkup(<PersonPhoto person={person} size={32} />);
    // Exactly one element, and it is the img itself: no wrapper, no placeholder
    // branch, no error-state markup. A future "let's add a fallback" change
    // that introduces a second element or a conditional would break this.
    expect(out.match(/<img/g)?.length).toBe(1);
    expect(out.startsWith("<img")).toBe(true);
  });

  it("still points at the route (which itself renders initials) when the person has no photo yet", () => {
    const noPhoto = { id: "p2", name: null, photoVersion: 0 };
    const out = renderToStaticMarkup(<PersonPhoto person={noPhoto} size={32} />);
    expect(out).toContain(`src="${photoUrl(noPhoto)}"`);
    expect(out.match(/<img/g)?.length).toBe(1);
  });
});
