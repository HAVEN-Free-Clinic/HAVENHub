import { describe, expect, it } from "vitest";
import { TopProgressBar } from "./top-progress-bar";

describe("TopProgressBar", () => {
  it("renders without throwing", () => {
    expect(() => TopProgressBar()).not.toThrow();
    expect(TopProgressBar()).toBeTruthy();
  });

  it("paints the bar in the brand color", () => {
    const el = TopProgressBar();
    expect(el.props.color).toBe("var(--color-brand)");
  });

  it("does not set shallowRouting, which would silence query-only navigations", () => {
    // Audit 14. The flag reads, inside @bprogress, as
    //   shallowRouting && isSameURLWithoutSearch(target, current) && disableSameURL -> return
    // i.e. it SUPPRESSES the bar whenever a navigation keeps the path and changes only
    // the query. Pagination, sorting, filtering, and term/view switching are all
    // `?`-only links in this app, and they are the ones that actually wait on the
    // database. With the flag set they had no loading indicator at all, because this
    // bar is the only one they get.
    const el = TopProgressBar();
    expect(el.props.shallowRouting).toBeUndefined();
  });

  it("leaves disableSameURL at the library default, so a byte-identical URL stays silent", () => {
    // The genuinely redundant case is still skipped; that default is not what broke
    // pagination, and forcing it here would be a different behaviour change.
    const el = TopProgressBar();
    expect(el.props.disableSameURL).toBeUndefined();
  });
});
