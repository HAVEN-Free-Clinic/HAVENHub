/**
 * Tests for the native-control dead-click filter.
 *
 * The load-bearing half is the NEGATIVE cases: dropping a real dead click hides
 * friction, so the tests that matter most prove the filter keeps dead clicks on
 * toggles, labels, buttons, and links -- the shapes that carry real signal.
 */

import { describe, expect, it } from "vitest";
import { isNativeControlDeadClickEvent } from "./native-control-dead-click";

const deadClickChain = (chain: string) => ({
  event: "$dead_click",
  properties: { $elements_chain: chain },
});

describe("isNativeControlDeadClickEvent", () => {
  // The captures that motivated this: the swap-partner select and note input on
  // /schedule, taken verbatim from the recorded dead clicks.
  it("drops a dead click on the swap-partner <select>", () => {
    expect(
      isNativeControlDeadClickEvent(
        deadClickChain(
          'select.bg-surface.border:attr__aria-label="Swap partner"attr__name="partner"nth-child="1";div.flex-1;form',
        ),
      ),
    ).toBe(true);
  });

  it("drops a dead click on the note <input> (type omitted, so text)", () => {
    expect(
      isNativeControlDeadClickEvent(
        deadClickChain(
          'input.bg-surface.border:attr__aria-label="Note"attr__name="note"nth-child="1";div.flex-1.min-w-48;form',
        ),
      ),
    ).toBe(true);
  });

  it("drops a dead click on the builder department <select>", () => {
    expect(
      isNativeControlDeadClickEvent(
        deadClickChain('select:attr__aria-label="Department"attr__name="dept"nth-child="3";form'),
      ),
    ).toBe(true);
  });

  it("drops a dead click on a <textarea>", () => {
    expect(isNativeControlDeadClickEvent(deadClickChain("textarea.w-full:attr__name=\"reason\";form"))).toBe(
      true,
    );
  });

  it.each(["text", "email", "search", "url", "tel", "password", "number"])(
    "drops a dead click on a text-entry input[type=%s]",
    (type) => {
      expect(
        isNativeControlDeadClickEvent(deadClickChain(`input:attr__type="${type}"attr__name="x";form`)),
      ).toBe(true);
    },
  );

  // --- Everything below must be KEPT ---

  // A checkbox that does not restyle its pill is the exact defect the
  // availability pills had (#687); its dead/rage clicks are how that regression
  // surfaces. Never filter it.
  it("keeps a dead click on an input[type=checkbox]", () => {
    expect(
      isNativeControlDeadClickEvent(deadClickChain('input:attr__type="checkbox"attr__name="dates";label')),
    ).toBe(false);
  });

  it("keeps a dead click on an input[type=radio]", () => {
    expect(isNativeControlDeadClickEvent(deadClickChain('input:attr__type="radio"attr__name="mode";form'))).toBe(
      false,
    );
  });

  // The large pill target is a <label> wrapping the checkbox; a dead click there
  // is the member-facing symptom of the same #687 defect.
  it("keeps a dead click on a <label>", () => {
    expect(isNativeControlDeadClickEvent(deadClickChain('label.rounded-full:attr__class="pill";div'))).toBe(
      false,
    );
  });

  it("keeps a dead click on a <button> (an action that did not fire)", () => {
    expect(isNativeControlDeadClickEvent(deadClickChain('button:attr__type="button"text="6";div'))).toBe(false);
  });

  it("keeps a dead click on an input[type=submit]", () => {
    expect(isNativeControlDeadClickEvent(deadClickChain('input:attr__type="submit";form'))).toBe(false);
  });

  it("keeps a dead click on a link", () => {
    expect(isNativeControlDeadClickEvent(deadClickChain('a.font-semibold:attr__href="/schedule";div'))).toBe(
      false,
    );
  });

  it("keeps a dead click on a static element (a stat card the member expected to be a link)", () => {
    expect(isNativeControlDeadClickEvent(deadClickChain('p.text-2xl:text="10";div.block.border;div'))).toBe(
      false,
    );
  });

  it("ignores non-dead-click events and empty input", () => {
    expect(isNativeControlDeadClickEvent(null)).toBe(false);
    expect(isNativeControlDeadClickEvent({ event: "$autocapture", properties: { $elements_chain: "select;form" } })).toBe(
      false,
    );
    expect(isNativeControlDeadClickEvent({ event: "$dead_click" })).toBe(false);
    expect(isNativeControlDeadClickEvent({ event: "$dead_click", properties: { $elements_chain: "" } })).toBe(
      false,
    );
  });
});
