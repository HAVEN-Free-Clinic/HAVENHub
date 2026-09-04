// @vitest-environment jsdom
/**
 * The reference counting and the dim are the whole contract here, and both are
 * stateful, so this needs a real DOM rather than static markup.
 *
 * `LinkPendingReporter` itself is not exercised: useLinkStatus reads the context
 * of an enclosing next/link, which cannot be stood up meaningfully in a unit
 * test. It is a two-line wrapper over useReportListPending, which IS covered.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ListPendingProvider, PendingDim, useReportListPending } from "./list-pending";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** Reports whatever `active` says, so a test can drive the counter. */
function Reporter({ active }: { active: boolean }) {
  useReportListPending(active);
  return null;
}

const dimmed = (el: HTMLElement) => {
  const div = el.querySelector("[class*='transition-opacity']") as HTMLElement;
  return { opacity: div.className.includes("opacity-50"), busy: div.getAttribute("aria-busy") };
};

describe("PendingDim", () => {
  it("renders its children untouched when nothing is pending", () => {
    const el = render(
      <ListPendingProvider>
        <PendingDim>
          <p>rows</p>
        </PendingDim>
      </ListPendingProvider>,
    );
    expect(el.textContent).toBe("rows");
    expect(dimmed(el).opacity).toBe(false);
    expect(dimmed(el).busy).toBeNull();
  });

  it("dims and blocks pointer events while something is pending", () => {
    const el = render(
      <ListPendingProvider>
        <Reporter active />
        <PendingDim>
          <p>rows</p>
        </PendingDim>
      </ListPendingProvider>,
    );
    const div = el.querySelector("[class*='transition-opacity']") as HTMLElement;
    expect(div.className).toContain("opacity-50");
    expect(div.className).toContain("pointer-events-none");
  });

  it("marks the region aria-busy, so the dim is not the only signal", () => {
    const el = render(
      <ListPendingProvider>
        <Reporter active />
        <PendingDim>rows</PendingDim>
      </ListPendingProvider>,
    );
    expect(dimmed(el).busy).toBe("true");
  });

  it("keeps the children mounted, so the rows are not thrown away", () => {
    const el = render(
      <ListPendingProvider>
        <Reporter active />
        <PendingDim>
          <p>rows</p>
        </PendingDim>
      </ListPendingProvider>,
    );
    expect(el.textContent).toBe("rows");
  });

  it("stays dimmed until the LAST reporter finishes", () => {
    function Two({ a, b }: { a: boolean; b: boolean }) {
      return (
        <ListPendingProvider>
          <Reporter active={a} />
          <Reporter active={b} />
          <PendingDim>rows</PendingDim>
        </ListPendingProvider>
      );
    }
    const el = render(<Two a b />);
    expect(dimmed(el).opacity).toBe(true);

    act(() => root!.render(<Two a={false} b />));
    expect(dimmed(el).opacity).toBe(true);

    act(() => root!.render(<Two a={false} b={false} />));
    expect(dimmed(el).opacity).toBe(false);
  });

  it("clears when a pending reporter unmounts mid-navigation", () => {
    function Maybe({ show }: { show: boolean }) {
      return (
        <ListPendingProvider>
          {show ? <Reporter active /> : null}
          <PendingDim>rows</PendingDim>
        </ListPendingProvider>
      );
    }
    const el = render(<Maybe show />);
    expect(dimmed(el).opacity).toBe(true);

    act(() => root!.render(<Maybe show={false} />));
    expect(dimmed(el).opacity).toBe(false);
  });

  it("merges a caller className, which is how Table keeps its card chrome", () => {
    const html = renderToStaticMarkup(
      <PendingDim className="overflow-x-auto rounded-2xl">rows</PendingDim>,
    );
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("rounded-2xl");
  });

  it("renders outside a provider without throwing, never dimmed", () => {
    const html = renderToStaticMarkup(<PendingDim>rows</PendingDim>);
    expect(html).toContain("rows");
    expect(html).not.toContain("opacity-50");
  });
});
