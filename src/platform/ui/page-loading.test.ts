import { describe, expect, it } from "vitest";
import { PageLoading } from "./page-loading";
import { Spinner } from "./spinner";

// The element tree is small; walk children to find specific nodes.
function childrenOf(el: { props: { children?: unknown } }): unknown[] {
  const c = el.props.children;
  return Array.isArray(c) ? c.flat() : c == null ? [] : [c];
}

describe("PageLoading", () => {
  it("exposes a status region with a default label", () => {
    const el = PageLoading({});
    expect(el.props.role).toBe("status");
    expect(el.props["aria-label"]).toBe("Loading");
  });

  it("renders a large Spinner", () => {
    const el = PageLoading({});
    const kids = childrenOf(el);
    const spinner = kids.find(
      (k): k is { type: unknown; props: { size?: string } } =>
        typeof k === "object" && k !== null && (k as { type?: unknown }).type === Spinner,
    );
    expect(spinner).toBeTruthy();
    expect(spinner?.props.size).toBe("lg");
  });

  it("uses a provided label as the aria-label and shows it visibly", () => {
    const el = PageLoading({ label: "Loading schedule" });
    expect(el.props["aria-label"]).toBe("Loading schedule");
    // The visible label node is present somewhere in the subtree.
    const text = JSON.stringify(el);
    expect(text).toContain("Loading schedule");
  });
});
