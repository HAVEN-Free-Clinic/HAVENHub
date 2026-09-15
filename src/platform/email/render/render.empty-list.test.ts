import { describe, expect, it } from "vitest";
import { removeEmptyListItems, renderTemplate } from "./render";

/** What the rich-text email editor saves for
 *  <ul><li>A</li>{{#if training}}<li>{{ training }}</li>{{/if}}<li>B</li></ul>:
 *  each marker lands in a list item of its own. */
const EDITOR_SAVED =
  "<ul><li><p>A</p></li><li><p>{{#if training}}</p></li><li><p>{{ training }}</p></li><li><p>{{/if}}</p></li><li><p>B</p></li></ul>";

describe("empty list items in rendered email HTML", () => {
  it("leaves no blank bullets around a shown conditional line", () => {
    expect(renderTemplate(EDITOR_SAVED, { training: "Attend training." })).toBe(
      "<ul><li><p>A</p></li><li><p>Attend training.</p></li><li><p>B</p></li></ul>",
    );
  });

  it("leaves no blank bullet where a hidden conditional line was", () => {
    expect(renderTemplate(EDITOR_SAVED, { training: "" })).toBe("<ul><li><p>A</p></li><li><p>B</p></li></ul>");
  });

  it("still renders the unedited default form correctly", () => {
    const source = "<ul><li>A</li>{{#if training}}<li>{{ training }}</li>{{/if}}</ul>";
    expect(renderTemplate(source, { training: "" })).toBe("<ul><li>A</li></ul>");
    expect(renderTemplate(source, { training: "T" })).toBe("<ul><li>A</li><li>T</li></ul>");
  });

  it("drops a list left with no items", () => {
    expect(removeEmptyListItems("<p>x</p><ul><li> </li><li><p>&nbsp;</p></li><li><p><br></p></li></ul>")).toBe("<p>x</p>");
  });

  it("keeps an item with content, and leaves plain-text renders alone", () => {
    expect(removeEmptyListItems("<ul><li><strong>A</strong></li></ul>")).toBe("<ul><li><strong>A</strong></li></ul>");
    expect(renderTemplate("<li></li>", {}, { escape: false })).toBe("<li></li>");
  });
});
