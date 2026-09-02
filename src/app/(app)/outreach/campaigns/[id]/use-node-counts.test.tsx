// @vitest-environment jsdom
/**
 * The counting hook's contract is entirely about TIMING, so that is what these
 * cover: counting runs on every edit, and without a debounce it would run on
 * every keystroke inside a text value. The out-of-order test is the one that
 * matters most -- a server action cannot be aborted, so a slow early response
 * is still in flight when a faster later one lands, and letting it win would
 * paint stale numbers next to a tree that no longer produces them.
 *
 * Follows audience-builder.test.tsx: bare createRoot + act(), no testing-library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Audience } from "@/platform/email/audience/types";
import { useNodeCounts, NODE_COUNT_DEBOUNCE_MS } from "./use-node-counts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Counts = Record<string, number>;
type CountAction = (audience: Audience) => Promise<Counts>;

let container: HTMLDivElement;
let root: Root;

function audienceWith(value: string): Audience {
  return {
    recordType: "PERSON",
    match: "ALL",
    conditions: [{ field: "name", op: "contains", value }],
  };
}

/** A root ALL over one leaf per value, for exercising shape changes. */
function audienceOf(...values: string[]): Audience {
  return {
    recordType: "PERSON",
    match: "ALL",
    conditions: values.map((value) => ({ field: "name", op: "contains", value })),
  };
}

function Harness({ audience, action }: { audience: Audience; action?: CountAction }) {
  const { counts, stale } = useNodeCounts(audience, action);
  return <div data-counts={JSON.stringify(counts)} data-stale={String(stale)} />;
}

function render(audience: Audience, action?: CountAction) {
  act(() => {
    root.render(<Harness audience={audience} action={action} />);
  });
}

function shown(): { counts: Counts; stale: boolean } {
  const el = container.querySelector("div")!;
  return {
    counts: JSON.parse(el.getAttribute("data-counts")!),
    stale: el.getAttribute("data-stale") === "true",
  };
}

/** Let the debounce elapse and any already-settled promise flush. */
async function settle(ms = NODE_COUNT_DEBOUNCE_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useNodeCounts", () => {
  it("waits out the debounce instead of counting on every edit", async () => {
    const action = vi.fn<CountAction>(async () => ({ root: 1 }));
    render(audienceWith("a"), action);

    // Three edits inside one debounce window, as typing three characters into a
    // value box produces.
    render(audienceWith("ab"), action);
    render(audienceWith("abc"), action);
    await settle(NODE_COUNT_DEBOUNCE_MS - 1);
    expect(action).not.toHaveBeenCalled();

    await settle(1);
    expect(action).toHaveBeenCalledTimes(1);
    // The one call it does make is for the LATEST tree, not the first.
    expect(action.mock.calls[0][0]).toEqual(audienceWith("abc"));
    expect(shown().counts).toEqual({ root: 1 });
  });

  it("does not let a slow earlier response overwrite a fresher one", async () => {
    const resolvers: ((counts: Counts) => void)[] = [];
    const action = vi.fn<CountAction>(
      () => new Promise<Counts>((resolve) => resolvers.push(resolve)),
    );

    render(audienceWith("first"), action);
    await settle();
    render(audienceWith("second"), action);
    await settle();
    expect(action).toHaveBeenCalledTimes(2);

    // The second request answers first, then the first request finally lands.
    await act(async () => {
      resolvers[1]({ root: 22 });
    });
    await act(async () => {
      resolvers[0]({ root: 11 });
    });

    expect(shown().counts).toEqual({ root: 22 });
    expect(shown().stale).toBe(false);
  });

  it("marks the showing counts stale from the edit until the answer lands", async () => {
    const resolvers: ((counts: Counts) => void)[] = [];
    const action = vi.fn<CountAction>(
      () => new Promise<Counts>((resolve) => resolvers.push(resolve)),
    );

    render(audienceWith("a"), action);
    await settle();
    await act(async () => {
      resolvers[0]({ root: 7 });
    });
    expect(shown()).toEqual({ counts: { root: 7 }, stale: false });

    // A new edit: the previous numbers stay on screen, flagged stale, rather
    // than blanking out and making every row flicker on each keystroke.
    render(audienceWith("ab"), action);
    expect(shown()).toEqual({ counts: { root: 7 }, stale: true });

    await settle();
    await act(async () => {
      resolvers[1]({ root: 8 });
    });
    expect(shown()).toEqual({ counts: { root: 8 }, stale: false });
  });

  it("clears the stale flag and keeps the last counts when a request fails", async () => {
    const settlers: { resolve: (c: Counts) => void; reject: (e: Error) => void }[] = [];
    const action = vi.fn<CountAction>(
      () => new Promise<Counts>((resolve, reject) => settlers.push({ resolve, reject })),
    );

    // A SUCCESSFUL answer first, so "keeps the last counts" is actually being
    // tested. Failing straight from the initial empty state asserts {} === {},
    // which passes whether the numbers are retained or wiped.
    render(audienceWith("a"), action);
    await settle();
    await act(async () => {
      settlers[0].resolve({ root: 12 });
    });
    expect(shown()).toEqual({ counts: { root: 12 }, stale: false });

    // A value edit, so the shape is unchanged and the old numbers are still
    // about the same clauses. Then the request for it fails.
    render(audienceWith("ab"), action);
    await settle();
    expect(shown()).toEqual({ counts: { root: 12 }, stale: true });
    await act(async () => {
      settlers[1].reject(new Error("network"));
    });

    // The numbers stay put rather than blanking, and the tree does not stay
    // dimmed forever waiting for an answer that is never coming.
    expect(shown()).toEqual({ counts: { root: 12 }, stale: false });
  });

  it("never counts without an action, which is how the scope editor renders", async () => {
    render(audienceWith("a"), undefined);
    await settle();
    expect(shown()).toEqual({ counts: {}, stale: false });
  });

  // The path every sender actually takes into the Audience tab. The editor's
  // panes are one form with hidden divs, so switching tabs is a soft nav that
  // RECONCILES rather than remounting: the builder stays mounted, the tree is
  // untouched, and the only thing that changes is `action` going from undefined
  // to a bound one. Nothing else in this hook's inputs moves, so if the effect
  // does not treat that transition as a reason to run, the sender lands on a
  // tree with no numbers under a note promising them, until they happen to edit
  // something. That shipped once.
  it("starts counting when an action arrives on a tree that has not otherwise changed", async () => {
    const action = vi.fn<CountAction>(async () => ({ root: 3 }));
    const tree = audienceWith("a");

    render(tree, undefined);
    await settle();
    expect(action).not.toHaveBeenCalled();

    // Byte-identical tree, only the action appears.
    render(tree, action);
    await settle();

    expect(action).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual({ counts: { root: 3 }, stale: false });
  });

  // The other half of finding F, which nothing pinned: the action's IDENTITY
  // must not re-trigger anything. The campaign editor rebinds it on every
  // render of the page, so depending on it (the obvious simplification once
  // the ref looks redundant) silently restores the per-render fan-out that
  // gating on the tab removed.
  it("ignores a fresh action identity on an unchanged tree", async () => {
    const calls: string[] = [];
    const first = vi.fn<CountAction>(async () => {
      calls.push("first");
      return { root: 1 };
    });
    const tree = audienceWith("a");

    render(tree, first);
    await settle();
    expect(calls).toEqual(["first"]);

    // A different function object, same tree, same behaviour: exactly what a
    // parent re-render hands down.
    const second = vi.fn<CountAction>(async () => {
      calls.push("second");
      return { root: 2 };
    });
    render(tree, second);
    await settle();

    expect(calls).toEqual(["first"]);
    expect(second).not.toHaveBeenCalled();
  });

  // Compose -> Audience and back. Returning re-enables counting, so a request
  // really is in flight, and the numbers on screen must say so. Keying the
  // in-flight signal on the tree alone got this wrong: the tree never changed
  // across the navigation, so the counts read settled while a request was out.
  it("shows the counts as in flight when returning to the tab re-enables counting", async () => {
    const resolvers: ((counts: Counts) => void)[] = [];
    const action = vi.fn<CountAction>(
      () => new Promise<Counts>((resolve) => resolvers.push(resolve)),
    );
    const tree = audienceWith("a");

    render(tree, action);
    await settle();
    await act(async () => {
      resolvers[0]({ root: 4 });
    });
    expect(shown()).toEqual({ counts: { root: 4 }, stale: false });

    // Leave the tab: no counting, and nothing claiming to be in flight.
    render(tree, undefined);
    await settle();
    expect(shown().stale).toBe(false);

    // Come back: a second request goes out for the same tree, so the numbers
    // showing are provisional until it lands.
    render(tree, action);
    await settle();
    expect(action).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual({ counts: { root: 4 }, stale: true });

    await act(async () => {
      resolvers[1]({ root: 6 });
    });
    expect(shown()).toEqual({ counts: { root: 6 }, stale: false });
  });

  it("stops counting when the action goes away again", async () => {
    const action = vi.fn<CountAction>(async () => ({ root: 3 }));
    const tree = audienceWith("a");

    render(tree, action);
    await settle();
    expect(action).toHaveBeenCalledTimes(1);

    render(tree, undefined);
    await settle();
    expect(action).toHaveBeenCalledTimes(1);
  });

  // Path keys are positional, so the retained map is only safe while the tree's
  // SHAPE is unchanged. These two are the cases where retaining it prints a
  // number against the wrong clause.
  describe("structural edits drop the map instead of retaining it", () => {
    const twoConditions: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "name", op: "contains", value: "a" },
        { field: "name", op: "contains", value: "b" },
      ],
    };

    async function withCounts(initial: Audience, counts: Counts) {
      const action = vi.fn<CountAction>(async () => counts);
      render(initial, action);
      await settle();
      expect(shown().counts).toEqual(counts);
      return action;
    }

    it("drops it when a clause is removed and later siblings shift down", async () => {
      const action = await withCounts(twoConditions, { root: 5, "0": 7, "1": 9 });

      // Remove the FIRST condition: what was "1" is now "0", so the retained
      // map would render 7 (the removed clause's count) against the survivor.
      render(
        { ...twoConditions, conditions: [twoConditions.conditions[1]] },
        action,
      );
      expect(shown().counts).toEqual({});
    });

    it("drops it when a group's connective flips, so the NONE label cannot attach to an ALL count", async () => {
      const grouped: Audience = {
        recordType: "PERSON",
        match: "ALL",
        conditions: [
          { match: "ALL", children: [{ field: "name", op: "contains", value: "a" }] },
        ],
      };
      const action = await withCounts(grouped, { root: 5, "0": 5, "0.0": 5 });

      // Same paths, same values, only the connective moved. The count for "0"
      // was compiled as an intersection; leaving it on screen would put
      // "(everyone matching none of these)" beside it.
      render(
        {
          ...grouped,
          conditions: [{ match: "NONE", children: [{ field: "name", op: "contains", value: "a" }] }],
        },
        action,
      );
      expect(shown().counts).toEqual({});
    });

    // Shapes RECUR. "Has this answer's shape changed since?" and "does this
    // answer's shape equal the current one?" are different questions, and only
    // the first one is safe: two clicks with controls that ship today (Remove,
    // then Add condition) land back on a shape a previous answer was compiled
    // under, while the clauses underneath are entirely different ones.
    it("does not revive a superseded answer when the tree returns to an earlier shape", async () => {
      const action = vi.fn<CountAction>(async () => ({ root: 5, "0": 7, "1": 9 }));
      render(audienceOf("alpha", "bravo"), action);
      await settle();
      expect(shown().counts).toEqual({ root: 5, "0": 7, "1": 9 });

      // Remove the FIRST clause. Shape changed, so the map goes.
      render(audienceOf("bravo"), action);
      expect(shown().counts).toEqual({});

      // Add a blank clause back. Same SHAPE as the answered tree, completely
      // different clauses: "0" is now bravo and "1" is a brand new blank row,
      // so reviving would print alpha's 7 and bravo's 9 against them.
      render(audienceOf("bravo", ""), action);
      expect(shown().counts).toEqual({});
    });

    // The same revival with no timing involved at all. A failed request keeps
    // the last answer on purpose (numbers stay put rather than blanking), so a
    // superseded answer can sit indefinitely with nothing in flight to correct
    // it, waiting for the shape to come back around.
    it("does not revive a superseded answer after an intermediate request fails", async () => {
      const settlers: { resolve: (c: Counts) => void; reject: (e: Error) => void }[] = [];
      const action = vi.fn<CountAction>(
        () => new Promise<Counts>((resolve, reject) => settlers.push({ resolve, reject })),
      );

      render(audienceOf("alpha", "bravo"), action);
      await settle();
      await act(async () => {
        settlers[0].resolve({ root: 5, "0": 7, "1": 9 });
      });
      expect(shown().counts).toEqual({ root: 5, "0": 7, "1": 9 });

      render(audienceOf("bravo"), action);
      await settle();
      await act(async () => {
        settlers[1].reject(new Error("network"));
      });
      expect(shown().counts).toEqual({});

      render(audienceOf("bravo", ""), action);
      expect(shown().counts).toEqual({});
    });

    it("keeps it for a pure value edit, which is the case dimming exists for", async () => {
      const action = await withCounts(twoConditions, { root: 5, "0": 7, "1": 9 });
      render(
        {
          ...twoConditions,
          conditions: [{ field: "name", op: "contains", value: "az" }, twoConditions.conditions[1]],
        },
        action,
      );
      expect(shown()).toEqual({ counts: { root: 5, "0": 7, "1": 9 }, stale: true });
    });
  });
});
