// @vitest-environment jsdom
/**
 * UploadSizeField guards both /my-info uploads against the platform's ~4.5 MB
 * Server Action body cap. Without the guard, an oversized file dies at the
 * platform edge before any app code runs: the action never redirects with an
 * error, so the form goes silent and the member retries with no feedback (#75).
 * These tests pin the guard that stops the oversized file from ever submitting.
 *
 * Bare createRoot + act(), following confirm-button.test.tsx: this repo has no
 * @testing-library/react.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UploadSizeField } from "./upload-size-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(maxMb = 4) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(<UploadSizeField name="photo" accept="image/png" maxMb={maxMb} />),
  );
  mounted = { container, root };
}

const input = () => mounted!.container.querySelector<HTMLInputElement>('input[type="file"]')!;
const errorText = () => mounted!.container.querySelector('[role="alert"]')?.textContent ?? null;

/** Assign a File list of the given sizes to the input, then fire change. */
function chooseFiles(sizes: number[]) {
  const files = sizes.map((size, i) => {
    const file = new File(["x"], `file-${i}.png`, { type: "image/png" });
    // jsdom builds the File from its contents, so set the reported size directly.
    Object.defineProperty(file, "size", { value: size });
    return file;
  });
  Object.defineProperty(input(), "files", { value: files, configurable: true });
  act(() => input().dispatchEvent(new Event("change", { bubbles: true })));
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe("UploadSizeField", () => {
  it("blocks an oversized file and shows a message", () => {
    mount(4);
    chooseFiles([5 * 1024 * 1024]);

    expect(errorText()).toContain("too large (max 4 MB)");
    // Native constraint validation blocks the submit while validity is set.
    expect(input().validationMessage).toContain("too large");
    expect(input().checkValidity()).toBe(false);
  });

  it("accepts a file within the cap", () => {
    mount(4);
    chooseFiles([2 * 1024 * 1024]);

    expect(errorText()).toBeNull();
    expect(input().validationMessage).toBe("");
    expect(input().checkValidity()).toBe(true);
  });

  it("clears a prior error once an allowed file replaces the oversized one", () => {
    mount(4);
    chooseFiles([5 * 1024 * 1024]);
    expect(input().checkValidity()).toBe(false);

    chooseFiles([1 * 1024 * 1024]);
    expect(errorText()).toBeNull();
    expect(input().checkValidity()).toBe(true);
  });
});
