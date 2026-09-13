// @vitest-environment jsdom
/**
 * The comment box emptied itself on every move between applicants and never
 * loaded the comment a scorer had already saved. Scoring sends whatever is in
 * the box, and the upsert writes it over the stored comment, so re-scoring an
 * applicant from "Show scored" (or stepping back to one with the arrow keys)
 * silently deleted the comment that was there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SpeedScoreModal } from "./speed-score-modal";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import type { ReviewApplicationView } from "@/modules/recruitment/services/speed-score";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(over: Partial<SpeedScoreItem> & { applicationId: string }): SpeedScoreItem {
  return { name: `Applicant ${over.applicationId}`, typeLabel: "New", myScore: null, myComment: null, ...over };
}

function view(applicationId: string): ReviewApplicationView {
  return { applicationId, name: applicationId, email: `${applicationId}@yale.edu`, typeLabel: "New", departmentChoices: [], sections: [] };
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;

async function mount(items: SpeedScoreItem[]) {
  const calls: [string, number, string | null][] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <SpeedScoreModal
        open
        onClose={() => {}}
        items={items}
        onScore={async (applicationId, score, comments) => {
          calls.push([applicationId, score, comments]);
          return {};
        }}
        onLoad={async (applicationId) => ({ view: view(applicationId) })}
      />,
    ),
  );
  mounted = { container, root };
  return calls;
}

/** The modal portals to document.body, so queries run against the whole document. */
const commentBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Comment (optional)"]');
const dialogTitle = () => document.querySelector("h2")?.textContent ?? "";

async function score(n: number) {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="Score ${n}"]`)?.click();
  });
}

async function pressArrowLeft() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  });
}

async function typeComment(text: string) {
  const input = commentBox()!;
  await act(async () => {
    // React tracks the input's value itself; set it through the native setter so
    // the input event reads as a real edit rather than a no-op.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.body.style.overflow = "";
});

describe("SpeedScoreModal comments", () => {
  it("re-scoring an applicant you already commented on keeps the comment", async () => {
    const calls = await mount([
      item({ applicationId: "a", myScore: 3, myComment: "Strong essay" }),
      item({ applicationId: "b" }),
    ]);
    // Opens on the one unscored applicant. Show scored, then step back to "a".
    await act(async () => {
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    });
    await pressArrowLeft();
    expect(dialogTitle()).toContain("Applicant a");

    expect(commentBox()?.value).toBe("Strong essay");
    await score(4);
    expect(calls).toEqual([["a", 4, "Strong essay"]]);
  });

  it("brings back a comment saved this session when you step back to that applicant", async () => {
    const calls = await mount([item({ applicationId: "a" }), item({ applicationId: "b" })]);

    await typeComment("Needs follow-up");
    await score(4);
    expect(calls).toEqual([["a", 4, "Needs follow-up"]]);
    expect(dialogTitle()).toContain("(2 of 2)");
    expect(commentBox()?.value).toBe("");

    await pressArrowLeft();
    expect(dialogTitle()).toContain("(1 of 2)");
    expect(commentBox()?.value).toBe("Needs follow-up");
  });
});
