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
import type { FormProblems } from "./form-state";

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

type Opts = {
  excludedCount?: number;
  pastedText?: string;
  savedAt?: string;
  searchAction?: (query: string) => Promise<PersonSearchHit[]>;
  pastedEmailsAction?: (prev: FormProblems, formData: FormData) => Promise<FormProblems>;
};

function panel(preview: Partial<AudiencePreview> | null, opts: Opts = {}) {
  return (
    <RecipientPreview
      formId="campaign-compose"
      savedAt={opts.savedAt ?? "2026-09-02T00:00:00.000Z"}
      preview={preview === null ? null : { ...EMPTY_PREVIEW, ...preview }}
      excludedCount={opts.excludedCount ?? 0}
      pastedText={opts.pastedText ?? ""}
      searchAction={opts.searchAction ?? (async () => [])}
      includeAction={() => {}}
      excludeAction={() => {}}
      clearExcludedAction={() => {}}
      pastedEmailsAction={opts.pastedEmailsAction ?? (async () => null)}
    />
  );
}

function render(preview: Partial<AudiencePreview> | null, opts: Opts = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(panel(preview, opts));
  });
}

/** A second server render arriving as a soft nav: same root, new props, no remount. */
function rerender(preview: Partial<AudiencePreview> | null, opts: Opts = {}) {
  act(() => {
    root.render(panel(preview, opts));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.getElementById("campaign-compose")?.remove();
});

/** Mounts the compose form the dirty guard listens to, before the panel renders. */
function mountComposeForm(): HTMLFormElement {
  const form = document.createElement("form");
  form.id = "campaign-compose";
  const input = document.createElement("input");
  form.appendChild(input);
  document.body.appendChild(form);
  return form;
}

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

  /** Types into the paste box the way a sender would. */
  function typePasted(value: string) {
    const box = container.querySelector<HTMLTextAreaElement>('textarea[name="pastedEmails"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // Half of the protection for unsaved pasted text: a new server render must
  // not reach into the box. The panel takes savedAt as a PROP for this reason
  // and must never be given a key that moves with it.
  it("keeps unsaved pasted addresses across a new server render", () => {
    render({ count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] });

    typePasted("typed-but-unsaved@example.com");

    // Exactly what an Exclude produces: a newer savedAt, a shorter roll, and
    // the pastedText prop unchanged because that action wrote a different column.
    rerender({ count: 0 }, { excludedCount: 1, savedAt: "2026-09-02T01:00:00.000Z" });

    const after = container.querySelector<HTMLTextAreaElement>('textarea[name="pastedEmails"]')!;
    expect(after.value).toBe("typed-but-unsaved@example.com");
  });

  // The sequence that used to walk straight past the guard: the editor opens on
  // Compose, the sender edits the subject there, and only THEN goes to the
  // Audience tab. The roll is resolved for that tab alone, so the panel has no
  // roll to show until the switch. If it only starts listening once the roll
  // arrives, it mounts believing nothing is dirty, and the first Exclude click
  // discards the unsaved compose state -- which is not only the paste box but
  // the entire audience tree, held in AudienceBuilder's own useState.
  it("has already seen a compose edit made before it had a roll to show", () => {
    const form = mountComposeForm();
    // No roll yet: this is the panel sitting on the Compose tab.
    render(null);

    act(() => {
      form.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The tab switch. Same root, so the panel reconciles the way a soft nav
    // reconciles it, and the roll arrives for the first time.
    rerender({ count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] });

    expect(button("Exclude")?.disabled).toBe(true);
    expect(text()).toContain("Save your changes before editing this list");
  });

  it("renders nothing until it has a roll, so it can stay mounted off the Audience tab", () => {
    render(null, { pastedText: "a@x.com" });
    expect(container.textContent).toBe("");
    expect(container.querySelector("textarea")).toBeNull();
  });

  // The server normalises a pasted block (splitting on commas and whitespace,
  // trimming, deduping) and hands it back joined by newlines, so what comes back
  // is routinely a different string from what was typed. Comparing the two
  // without re-seeding leaves the guard latched on after a SUCCESSFUL save: the
  // controls stay disabled and the notice keeps insisting the addresses are
  // unsaved when they are stored.
  it("clears the unsaved-paste guard when the server accepts a block it normalised", () => {
    render(
      { count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] },
      { pastedText: "a@x.com" },
    );

    typePasted("a@x.com, b@x.com\n");
    expect(button("Exclude")?.disabled).toBe(true);

    // What Save addresses produces: the same two addresses, normalised, plus a
    // newer savedAt. The typed string and the stored one do not match.
    rerender(
      { count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] },
      { pastedText: "a@x.com\nb@x.com", savedAt: "2026-09-02T03:00:00.000Z" },
    );

    expect(button("Exclude")?.disabled).toBe(false);
    expect(text()).not.toContain("Save these addresses, or discard them");
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[name="pastedEmails"]')!.value,
    ).toBe("a@x.com\nb@x.com");
  });

  // Both guards at once. The clean-compose wording is untrue in
  // that state, because Save addresses is itself disabled by the compose guard.
  it("says something true when the compose form is dirty and the paste box is not saved", () => {
    const form = mountComposeForm();
    render(
      { count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] },
      { pastedText: "a@x.com" },
    );
    typePasted("a@x.com\nb@x.com");
    act(() => {
      form.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(button("Save addresses")?.disabled).toBe(true);
    expect(text()).not.toContain("Save these addresses, or discard them");
    expect(text()).toContain("cannot be saved while the compose form has unsaved changes");
    // Discard is the only thing still available, and stays available.
    expect(button("Discard")?.disabled).toBeFalsy();
  });

  // The other half of the paste protection, and the one that actually closes the
  // hole. A redirecting server action can replace the whole page tree, which no
  // component-level trick survives, so while the box holds anything unsaved the
  // controls that navigate are refused outright.
  it("refuses to navigate while the paste box holds unsaved text, and says why", () => {
    render(
      { count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] },
      { excludedCount: 2, pastedText: "saved@example.com" },
    );
    expect(button("Exclude")?.disabled).toBe(false);
    expect(button("Restore all")?.disabled).toBe(false);

    typePasted("saved@example.com\nhalf-typed@examp");

    expect(button("Exclude")?.disabled).toBe(true);
    expect(button("Restore all")?.disabled).toBe(true);
    // The paste box's own save is the way out and must stay live.
    expect(button("Save addresses")?.disabled).toBe(false);
    expect(text()).toContain("Save these addresses, or discard them, before using the controls above");
    // The compose form's own Save is the one control that can still reach this
    // text, and the warning that omitted it was the one a sender would trust.
    expect(text()).toContain("the compose form's own Save");

    // Discard is the other way out, for a sender who does not want to keep it.
    act(() => button("Discard")!.click());
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[name="pastedEmails"]')!.value,
    ).toBe("saved@example.com");
    expect(button("Exclude")?.disabled).toBe(false);
    expect(button("Restore all")?.disabled).toBe(false);
  });

  it("re-enables its controls once a newer saved version arrives", () => {
    const form = mountComposeForm();
    render({ count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] });
    expect(button("Exclude")?.disabled).toBe(false);

    // An edit anywhere in the compose form: the roll on screen now describes a
    // version that is no longer what would be sent.
    act(() => {
      form.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Exclude")?.disabled).toBe(true);

    // The save lands. Without the savedAt prop the panel would have to be
    // remounted to notice, and remounting is what destroys the paste box.
    rerender(
      { count: 1, sample: [{ personId: "p1", name: "A", email: "a@x.com", reason: "matched" }] },
      { savedAt: "2026-09-02T02:00:00.000Z" },
    );
    expect(button("Exclude")?.disabled).toBe(false);
  });

  it("blames hand-exclusions, not the conditions, when they are what emptied the roll", () => {
    render({ count: 0 }, { excludedCount: 3 });
    expect(text()).toContain("Nobody is left on this list");
    expect(text()).toContain("3 people were excluded by hand");
    expect(text()).not.toContain("check that every condition has a value");

    act(() => root.unmount());
    container.remove();

    render({ count: 0 });
    expect(text()).toContain("check that every condition has a value");
    expect(text()).not.toContain("Nobody is left on this list");
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
