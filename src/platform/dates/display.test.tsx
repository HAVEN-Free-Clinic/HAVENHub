import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarDate } from "./display";

describe("CalendarDate", () => {
  it("renders a UTC calendar day inside a <time>", () => {
    const html = renderToStaticMarkup(<CalendarDate value={new Date("2026-06-13T00:00:00Z")} />);
    expect(html).toContain("Jun 13, 2026");
    // react-dom's SSR string output preserves the JSX prop's camelCase for
    // `dateTime` (verified: react-dom 19.2.4 does not translate it to the
    // lowercase HTML attribute name the way it does className/htmlFor/tabIndex).
    // Real browsers lowercase attribute names during HTML parsing, so this is
    // equivalent to `datetime="2026-06-13"` once the markup reaches the DOM.
    expect(html).toContain('dateTime="2026-06-13"');
  });
  it("renders the fallback for null", () => {
    expect(renderToStaticMarkup(<CalendarDate value={null} fallback="TBD" />)).toBe("TBD");
  });
});
