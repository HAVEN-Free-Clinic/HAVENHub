import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { PageHeader } from "./page-header";

/**
 * React 19 types `ReactElement["props"]` as `unknown`, so these read props
 * through a permissive shape rather than casting at every assertion (the same
 * approach empty-state.test.ts takes).
 */
type Props = { className?: string; children?: unknown; [key: string]: unknown };

const render = (props: Parameters<typeof PageHeader>[0]) =>
  PageHeader(props) as ReactElement<Props>;

/** Flatten the rendered tree to the nodes a caller passed in. */
function nodes(el: unknown, out: unknown[] = []): unknown[] {
  if (el == null || typeof el !== "object") return out;
  if (Array.isArray(el)) {
    el.forEach((c) => nodes(c, out));
    return out;
  }
  out.push(el);
  const props = (el as ReactElement<Props>).props;
  if (props && "children" in props) nodes(props.children, out);
  return out;
}

const STATUS = { marker: "status-node" } as unknown as ReactElement;
const ACTION = { marker: "action-node" } as unknown as ReactElement;

describe("PageHeader slots", () => {
  it("renders a status node when given one", () => {
    const found = nodes(render({ title: "Summer 2026", status: STATUS }));
    expect(found).toContain(STATUS);
  });

  it("renders an action node when given one", () => {
    const found = nodes(render({ title: "People", action: ACTION }));
    expect(found).toContain(ACTION);
  });

  it("keeps status and action in different places", () => {
    // The single `action` slot used to carry both, so the top-right of a page
    // was sometimes the thing you do and sometimes a read-only fact.
    const el = render({ title: "Summer 2026", status: STATUS, action: ACTION });
    const [heading, right] = (el.props.children as ReactElement<Props>[]).filter(Boolean);
    expect(nodes(heading)).toContain(STATUS);
    expect(nodes(heading)).not.toContain(ACTION);
    expect(nodes(right)).toContain(ACTION);
  });

  it("still renders with neither slot", () => {
    const el = render({ title: "Attributions" });
    expect(nodes(el)).not.toContain(STATUS);
    expect(nodes(el)).not.toContain(ACTION);
  });

  it("renders the description only when given", () => {
    const withDesc = JSON.stringify(render({ title: "T", description: "D" }));
    expect(withDesc).toContain("D");
    expect(JSON.stringify(render({ title: "T" }))).not.toContain("D");
  });
});
