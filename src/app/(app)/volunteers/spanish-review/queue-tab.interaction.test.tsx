// @vitest-environment jsdom
/**
 * The language review queue's bulk bar posts one `entry` per ticked row.
 *
 * The load-bearing property is that what the form POSTS is what the reviewer
 * ticked, carrying the score each row shows. A wrong row is a person recorded
 * as assessed who never was; a wrong score is a verdict with the wrong number
 * on it, and the bulk form reads that number from outside the row's own form.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueueTab } from "./queue-tab";
import type { LanguageReviewRow } from "@/platform/languages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = async () => {};

function row(fields: Partial<LanguageReviewRow> & Pick<LanguageReviewRow, "id" | "name">): LanguageReviewRow {
  return {
    source: "member",
    personId: `p-${fields.id}`,
    applicationId: null,
    netId: null,
    language: "es",
    languageLabel: "Spanish",
    score: null,
    contextLabel: "Fall 2026",
    departments: [],
    ...fields,
  };
}

const ROWS = [
  row({ id: "app:es", name: "Ada Applicant", source: "applicant", personId: null, applicationId: "app" }),
  row({ id: "m1", name: "Ana Reyes", score: 3 }),
  row({ id: "m2", name: "Bo Chen", language: "pt", languageLabel: "Portuguese" }),
];

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(rows: LanguageReviewRow[] = ROWS) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueueTab
        rows={rows}
        assessMemberAction={noop}
        assessApplicantAction={noop}
        bulkAssessAction={noop}
      />,
    ),
  );
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

/** The bulk form for one verdict: the only forms with a hidden `verified` input. */
const bulkForm = (c: HTMLElement, verified: "true" | "false") =>
  c.querySelector(`input[type="hidden"][name="verified"][value="${verified}"]`)!.closest("form")!;

/** What that form would actually POST. */
const posted = (c: HTMLElement, verified: "true" | "false") =>
  [...bulkForm(c, verified).querySelectorAll<HTMLInputElement>('input[name="entry"]')].map(
    (i) => JSON.parse(i.value) as Record<string, unknown>,
  );

const box = (c: HTMLElement, label: string) =>
  c.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)!;

function click(el: HTMLElement, shiftKey = false) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
  });
}

describe("language review queue bulk bar", () => {
  it("posts nothing and offers nothing to press until a row is ticked", () => {
    const c = mount();
    expect(posted(c, "true")).toEqual([]);
    expect(bulkForm(c, "true").querySelector("button")!.disabled).toBe(true);
    expect(bulkForm(c, "false").querySelector("button")!.disabled).toBe(true);
  });

  it("posts exactly the ticked rows to both verdicts, each with its own fields", () => {
    const c = mount();
    click(box(c, "Select Ada Applicant, Spanish"));
    click(box(c, "Select Bo Chen, Portuguese"));

    const expected = [
      { source: "applicant", applicationId: "app", language: "es", score: "" },
      // No score key at all: a non-Spanish row's own form asks for none, and
      // an absent score is what leaves one on record alone.
      { source: "member", personId: "p-m2", language: "pt" },
    ];
    expect(posted(c, "true")).toEqual(expected);
    expect(posted(c, "false")).toEqual(expected);
    expect(bulkForm(c, "true").querySelector("button")!.disabled).toBe(false);
  });

  it("posts the score a row shows, including one the reviewer just changed", () => {
    const c = mount();
    const ana = box(c, "Select Ana Reyes, Spanish");
    click(ana);
    expect(posted(c, "true")).toEqual([
      { source: "member", personId: "p-m1", language: "es", score: "3" },
    ]);

    const select = ana.closest("tr")!.querySelector("select")!;
    act(() => {
      select.value = "5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(select.value).toBe("5");
    expect(posted(c, "true")).toEqual([
      { source: "member", personId: "p-m1", language: "es", score: "5" },
    ]);
  });

  it("selects everyone from the header box, and a range with shift-click", () => {
    const c = mount();
    const header = box(c, "Select everyone in the queue");

    click(header);
    expect(posted(c, "true")).toHaveLength(3);
    click(header);
    expect(posted(c, "true")).toEqual([]);

    click(box(c, "Select Ada Applicant, Spanish"));
    click(box(c, "Select Bo Chen, Portuguese"), true);
    expect(posted(c, "true").map((e) => e.language)).toEqual(["es", "es", "pt"]);
  });

  it("drops a row from the post once it leaves the queue", () => {
    const c = mount();
    click(box(c, "Select everyone in the queue"));
    expect(posted(c, "true")).toHaveLength(3);

    // What revalidatePath does after an assessment: fresh rows, same component.
    act(() =>
      mounted!.root.render(
        <QueueTab
          rows={ROWS.slice(1)}
          assessMemberAction={noop}
          assessApplicantAction={noop}
          bulkAssessAction={noop}
        />,
      ),
    );
    expect(posted(c, "true").map((e) => e.source)).toEqual(["member", "member"]);
  });
});
