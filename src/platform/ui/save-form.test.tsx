// @vitest-environment jsdom
/**
 * SaveForm exists so the course editor stops scrolling to the top on every
 * save, and the "Saved" note is the only confirmation left once the redirect
 * (and with it the flash toast) is gone. Both halves are pinned here: the note
 * appears on a success, it goes away on its own, and it never appears for a
 * save that threw -- which is what a redirecting error path looks like from
 * inside the action.
 *
 * Bare createRoot + act(), following confirm-button.test.tsx: this repo has no
 * @testing-library/react.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveForm } from "./save-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(action: (formData: FormData) => Promise<void>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SaveForm action={action}>
        <button type="submit">Save section</button>
      </SaveForm>
    )
  );
  mounted = { container, root };
  return container;
}

/** The live region SaveForm renders beside the button. */
function note(container: HTMLDivElement): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

async function submit(container: HTMLDivElement) {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.requestSubmit(container.querySelector("button")!);
    // Let the action's promise and the state update that follows it settle.
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

it("says nothing until a save succeeds, then clears itself", async () => {
  const action = vi.fn(async () => undefined);
  const container = mount(action);
  expect(note(container)).toBe("");

  await submit(container);

  expect(action).toHaveBeenCalledOnce();
  expect(note(container)).toBe("Saved");

  act(() => void vi.advanceTimersByTime(2600));
  expect(note(container)).toBe("");
});

it("restarts the note on a second save, rather than leaving a stale one", async () => {
  const container = mount(vi.fn(async () => undefined));
  await submit(container);
  act(() => void vi.advanceTimersByTime(2000));
  expect(note(container)).toBe("Saved");

  await submit(container);
  // 2000ms into the FIRST note's life; a boolean would have expired here.
  act(() => void vi.advanceTimersByTime(1000));
  expect(note(container)).toBe("Saved");
});

it("says nothing when the action throws, which is what an error redirect does", async () => {
  const container = mount(
    vi.fn(async () => {
      throw new Error("NEXT_REDIRECT");
    })
  );

  const form = container.querySelector("form")!;
  // React re-throws a rejected form action; the point of the test is that the
  // state update after `await action(...)` never runs, so swallow the throw
  // and read the note.
  try {
    await act(async () => {
      form.requestSubmit(container.querySelector("button")!);
      await Promise.resolve();
    });
  } catch {
    // expected: the action rejected, exactly as a redirect does
  }

  expect(note(container)).toBe("");
});
