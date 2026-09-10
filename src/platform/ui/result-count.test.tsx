/**
 * A pure extraction, with no red-before-green test available: the two spans this
 * replaces were inline JSX, one inside an async server page and one inside a
 * hook-using client component, and neither can be rendered from here.
 *
 * The guard on the extraction itself is filter-bar.test.tsx: its four existing
 * `resultCount` assertions must stay green through this change, and the last
 * test below pins FilterBar's slot to this component's own markup so the two
 * cannot fork again.
 *
 * What these assertions pin is the component's contract, including the
 * `ml-auto` the two hand-copied spans had both dropped.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultCount } from "./result-count";
import { FilterBar, FilterField } from "./filter-bar";
import { Input } from "./input";

// FilterBar renders through NavForm, a client component reading router hooks.
vi.mock("next/navigation", () => ({
  usePathname: () => "/support/all",
  useRouter: () => ({ push: () => {} }),
}));

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("ResultCount", () => {
  it("separates thousands, which two queues were not doing", () => {
    expect(render(<ResultCount total={1234} noun="member" />)).toContain("1,234 members");
  });

  it("agrees with itself about singular and plural", () => {
    const one = render(<ResultCount total={1} noun="report" />);
    expect(one).toContain("1 report");
    expect(one).not.toContain("1 reports");
  });

  it("takes an irregular plural rather than bolting an s onto the noun", () => {
    expect(
      render(<ResultCount total={42} noun="active person" pluralNoun="active people" />),
    ).toContain("42 active people");
    expect(render(<ResultCount total={7} noun="entry" pluralNoun="entries" />)).toContain(
      "7 entries",
    );
  });

  it("carries its own trailing-edge placement", () => {
    // Not a repair of the two hand-rolled copies: neither was mispositioned.
    // The applicants roster already sat in a justify-between row of two, and the
    // request filters put flex-1 on the form before it. This is so the slot
    // holds its placement in whatever row the NEXT caller builds, and when
    // either of these rows wraps.
    expect(render(<ResultCount total={3} noun="request" />)).toContain("ml-auto");
  });

  it("renders exactly what FilterBar's slot renders", () => {
    // The two cannot fork again: FilterBar delegates to this component, and this
    // asserts the delegation rather than trusting it.
    const standalone = render(<ResultCount total={1234} noun="member" />);
    const inBar = render(
      <FilterBar resultCount={{ total: 1234, noun: "member" }}>
        <FilterField label="Search">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    expect(inBar).toContain(standalone);
  });
});
