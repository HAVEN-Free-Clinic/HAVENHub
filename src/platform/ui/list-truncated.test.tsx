import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ListTruncated } from "./list-truncated";

/**
 * Three lists said this in two sizes and two ink tokens, and two of the three
 * printed the total as a bare integer -- on the notice where a large number is
 * most likely to appear.
 */
describe("ListTruncated", () => {
  it("prints a thousands separator, which two of three sites did not", () => {
    const out = renderToStaticMarkup(<ListTruncated shown={50} total={1284} />);
    expect(out).toContain("1,284");
    expect(out).not.toContain("of 1284");
  });

  it("separates the shown count too, for a large page size", () => {
    expect(renderToStaticMarkup(<ListTruncated shown={2000} total={12840} />)).toContain("2,000");
  });

  it("appends the hint after the count, not instead of it", () => {
    const out = renderToStaticMarkup(
      <ListTruncated shown={50} total={1284} hint="Narrow your search to see more." />,
    );
    expect(out).toContain("of 1,284. Narrow your search to see more.");
  });

  it("says just the counts when there is nothing useful to add", () => {
    const out = renderToStaticMarkup(<ListTruncated shown={5} total={9} />);
    expect(out).toContain("Showing the first 5 of 9.");
    expect(out).not.toContain(". .");
  });
});
