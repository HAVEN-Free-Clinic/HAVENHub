// @vitest-environment jsdom
/**
 * What the recipient panel actually puts in front of a sender.
 *
 * The load-bearing case is the unresolved-address report: the service is
 * careful to make an address belonging to nobody indistinguishable from one
 * belonging to a real person outside the campaign's scope, and that care is
 * wasted if the UI renders the two differently. It cannot, because it is handed
 * one flat list of strings with no marker on any of them -- these tests pin
 * that shape by asserting the rendered wording is the same for both.
 *
 * Follows audience-builder.test.tsx: bare createRoot + act(), no
 * testing-library.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AudiencePreview } from "@/platform/email/campaigns/service";
import type { PersonSearchHit } from "@/platform/email/audience/resolve";
import { RecipientPreview } from "./recipient-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const EMPTY_PREVIEW: AudiencePreview = {
  count: 0,
  excludedNoEmail: 0,
  sample: [],
  truncated: false,
  unresolved: [],
};

function render(
  preview: Partial<AudiencePreview>,
  opts: {
    excludedCount?: number;
    pastedText?: string;
    searchAction?: (query: string) => Promise<PersonSearchHit[]>;
  } = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <RecipientPreview
        formId="campaign-compose"
        preview={{ ...EMPTY_PREVIEW, ...preview }}
        excludedCount={opts.excludedCount ?? 0}
        pastedText={opts.pastedText ?? ""}
        searchAction={opts.searchAction ?? (async () => [])}
        includeAction={() => {}}
        excludeAction={() => {}}
        clearExcludedAction={() => {}}
        pastedEmailsAction={() => {}}
      />,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function text(): string {
  return container.textContent ?? "";
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
}

describe("RecipientPreview", () => {
  it("lists each recipient with the reason they are in the roll", () => {
    render({
      count: 3,
      sample: [
        { personId: "p1", name: "Anna Matched", email: "a@example.com", reason: "matched" },
        { personId: "p2", name: "Bea Included", email: "b@example.com", reason: "included" },
        { personId: "p3", name: "Cal Pasted", email: "c@example.com", reason: "pasted" },
      ],
    });

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.querySelectorAll("td")[0].textContent)).toEqual([
      "Anna Matched",
      "Bea Included",
      "Cal Pasted",
    ]);
    // Read out of the row they belong to, in order, so a panel that rendered
    // one constant for all three -- or the right three against the wrong
    // people -- fails rather than satisfying three independent "contains".
    expect(rows.map((r) => r.querySelectorAll("td")[2].textContent)).toEqual([
      "Condition match",
      "Added by search",
      "Pasted address",
    ]);
  });

  it("carries the person id on each row's exclude control", () => {
    render({
      count: 1,
      sample: [{ personId: "p-42", name: "Anna", email: "a@example.com", reason: "matched" }],
    });

    const hidden = container.querySelector<HTMLInputElement>('input[name="personId"]');
    expect(hidden?.value).toBe("p-42");
    expect(button("Exclude")).toBeTruthy();
  });

  // The UI half of the indistinguishability rule. An address that belongs to a
  // real person outside the scope and one that belongs to nobody arrive here as
  // two ordinary strings in one array, so the panel has nothing to tell them
  // apart WITH -- and this asserts it does not invent a difference (a per-entry
  // marker, a second list, a split heading).
  it("reports every unreachable pasted address in one list with one wording", () => {
    render({ unresolved: ["real-outsider@example.com", "nobody-at-all@example.com"] });

    const items = [...container.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items).toEqual(["real-outsider@example.com", "nobody-at-all@example.com"]);
    expect(text()).toContain("2 pasted addresses will not be emailed");
    // Says both possibilities in one breath, so a sender cannot read a listed
    // address as proof that nobody has it.
    expect(text()).toContain(
      "An address is listed here whether nobody has it or somebody outside this campaign's audience scope does",
    );
  });

  it("surfaces the people dropped for having no email address", () => {
    render({ count: 4, excludedNoEmail: 2 });
    expect(text()).toContain("2 matched but have no email address on file");
  });

  it("offers a restore only once something has been excluded by hand", () => {
    render({ count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] });
    expect(button("Restore all")).toBeFalsy();

    act(() => root.unmount());
    container.remove();

    render(
      { count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] },
      { excludedCount: 2 },
    );
    expect(text()).toContain("2 excluded by hand");
    expect(button("Restore all")).toBeTruthy();
  });

  it("runs the search only once the query is long enough, and lists what comes back", async () => {
    const searchAction = vi.fn(async () => [
      { personId: "p9", name: "Rivera Sam", email: "sam@example.com" },
    ]);
    render({}, { searchAction });

    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setValue = (v: string) => {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    setValue("R");
    expect(button("Search")?.disabled).toBe(true);

    setValue("Rivera");
    expect(button("Search")?.disabled).toBe(false);
    await act(async () => {
      button("Search")!.click();
    });

    expect(searchAction).toHaveBeenCalledWith("Rivera");
    expect(text()).toContain("Rivera Sam");
    expect(text()).toContain("sam@example.com");
    // The add control carries the id the server search returned, not the name
    // the sender typed.
    const hidden = [...container.querySelectorAll<HTMLInputElement>('input[name="personId"]')];
    expect(hidden.map((h) => h.value)).toEqual(["p9"]);
  });
});
