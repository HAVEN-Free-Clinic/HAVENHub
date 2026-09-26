// @vitest-environment jsdom
/**
 * Every "Try again" on an error boundary must call `retry()`, not `reset()`.
 *
 * In this Next version `reset()` clears the error and re-renders what the client
 * already holds, without a request, so an error that came from a failed fetch is
 * thrown straight back. Error Tracking recorded exactly that (Sep 14-23: 6
 * "TypeError: Load failed" / "Error in input stream" events, 4 members, mostly on
 * the applicants roster): each press re-logged the same error ~45ms later. The
 * fix is `retry()`, which refreshes the route first.
 *
 * Two layers. The click test proves each boundary we have wires the button to
 * `retry`. The source scan catches a boundary added later that copies an old
 * example and calls `reset()` again.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useParams: () => ({ id: "cycle-1" }),
}));

import AppError from "./(app)/error";
import ApplicantDetailError from "./(app)/recruitment/cycles/[id]/applicants/[applicationId]/error";
import ApplyError from "./apply/[slug]/error";
import GetStartedError from "./get-started/error";
import OnboardError from "./onboard/[token]/error";

type BoundaryProps = { error: Error & { digest?: string }; retry: () => void; reset: () => void };

// global-error renders its own <html>/<body>, which cannot mount inside a test
// container; the source scan below covers it.
const boundaries: [string, ComponentType<BoundaryProps>][] = [
  ["(app)/error.tsx", AppError as ComponentType<BoundaryProps>],
  ["applicant detail error.tsx", ApplicantDetailError as ComponentType<BoundaryProps>],
  ["apply/[slug]/error.tsx", ApplyError as ComponentType<BoundaryProps>],
  ["get-started/error.tsx", GetStartedError as ComponentType<BoundaryProps>],
  ["onboard/[token]/error.tsx", OnboardError as ComponentType<BoundaryProps>],
];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

describe("error boundary Try again", () => {
  it.each(boundaries)("%s re-fetches with retry(), never reset()", async (_name, Boundary) => {
    const retry = vi.fn();
    const reset = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    // The exact message a member on Mobile Safari hit on the roster.
    await act(async () => {
      root.render(<Boundary error={new TypeError("Load failed")} retry={retry} reset={reset} />);
    });

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Try again"),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

function boundaryFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return boundaryFiles(full);
    return entry.name === "error.tsx" || entry.name === "global-error.tsx" ? [full] : [];
  });
}

describe("every boundary file under src/app", () => {
  const files = boundaryFiles(__dirname);

  it("finds the boundaries, so the scan cannot pass vacuously", () => {
    expect(files.some((f) => f.endsWith("global-error.tsx"))).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(boundaries.length + 1);
  });

  it.each(files.map((f) => [path.relative(__dirname, f)]))(
    "%s takes retry and never calls reset()",
    (relative) => {
      const source = readFileSync(path.join(__dirname, relative), "utf8");
      expect(source).toMatch(/\bretry\s*:\s*\(\)\s*=>\s*void/);
      // A call, not a mention: prose in comments names `reset()` in backticks
      // to explain why it is not used.
      expect(source).not.toMatch(/(?<![`\w])reset\s*\(\s*\)/);
    },
  );
});
