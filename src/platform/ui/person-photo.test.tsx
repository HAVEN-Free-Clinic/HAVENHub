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
    // Guards the STRUCTURAL fallback case only: a wrapper, a placeholder
    // branch, a second element for an error state. It does NOT guard an
    // event-handler fallback (onError/onLoad) added to this same single
    // <img>, since renderToStaticMarkup does not serialize event-handler
    // props into its output. See the element-props test below for that.
    expect(out.match(/<img/g)?.length).toBe(1);
    expect(out.startsWith("<img")).toBe(true);
  });

  it("still points at the route (which itself renders initials) when the person has no photo yet", () => {
    const noPhoto = { id: "p2", name: null, photoVersion: 0 };
    const out = renderToStaticMarkup(<PersonPhoto person={noPhoto} size={32} />);
    expect(out).toContain(`src="${photoUrl(noPhoto)}"`);
    expect(out.match(/<img/g)?.length).toBe(1);
  });

  // The markup assertions above only guard the STRUCTURAL case: a wrapper, a
  // conditional, a second element. React does not serialize event-handler
  // props into renderToStaticMarkup output, so an onError/onLoad fallback
  // handler added to the same single <img> would be invisible there and
  // those tests would keep passing. PersonPhoto is a plain function that
  // returns a React element, so call it directly and inspect the element's
  // props instead: this is the only way to guard against a client-side
  // fallback handler, which is the specific regression the design forbids.
  it("carries no onError or onLoad handler on the returned element", () => {
    const el = PersonPhoto({ person, size: 32 });
    expect(el.props.onError).toBeUndefined();
    expect(el.props.onLoad).toBeUndefined();
  });
});
