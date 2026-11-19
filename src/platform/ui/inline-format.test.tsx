import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatInline, stripInlineFormatting, toggleMarker, HIGHLIGHT_CLASS } from "./inline-format";

const html = (text: string) => renderToStaticMarkup(<>{formatInline(text)}</>);

describe("formatInline", () => {
  it("turns the three markers into bold, italic and highlight", () => {
    expect(html("**Required** for all")).toBe('<strong class="font-semibold">Required</strong> for all');
    expect(html("Please *only* upload a PDF")).toBe("Please <em>only</em> upload a PDF");
    expect(html("==Due Friday==")).toBe(`<mark class="${HIGHLIGHT_CLASS}">Due Friday</mark>`);
  });

  it("nests, including bold around italic at the end", () => {
    expect(html("**bold *italic***")).toBe('<strong class="font-semibold">bold <em>italic</em></strong>');
    expect(html("==**important**==")).toBe(`<mark class="${HIGHLIGHT_CLASS}"><strong class="font-semibold">important</strong></mark>`);
  });

  it("leaves text that only looks like markers as typed", () => {
    for (const plain of ["5 * 3 * 2", "a lone * star", "file_name*", "** not bold **", "x==y", "unclosed **bold"]) {
      expect(html(plain)).toBe(plain.replace(/&/g, "&amp;"));
    }
  });

  it("never lets typed HTML through", () => {
    expect(html("**<img src=x onerror=alert(1)>**")).toBe(
      '<strong class="font-semibold">&lt;img src=x onerror=alert(1)&gt;</strong>',
    );
  });

  it("still makes links clickable, inside formatting too", () => {
    expect(html("See **havenfreeclinic.com/apply**")).toContain('href="https://havenfreeclinic.com/apply"');
    expect(html("See **havenfreeclinic.com/apply**")).toContain("<strong");
  });
});

describe("stripInlineFormatting", () => {
  it("removes markers, nested ones too, and keeps everything else", () => {
    expect(stripInlineFormatting("**bold *italic*** and ==hi==")).toBe("bold italic and hi");
    expect(stripInlineFormatting("5 * 3 * 2")).toBe("5 * 3 * 2");
    expect(stripInlineFormatting("Use *italic*, then **bold**.")).toBe("Use italic, then bold.");
  });
});

describe("toggleMarker", () => {
  it("wraps the selection", () => {
    expect(toggleMarker("Upload a PDF", 9, 12, "**")).toEqual({ value: "Upload a **PDF**", start: 11, end: 14 });
  });

  it("unwraps a selection that is already wrapped in the same marker", () => {
    expect(toggleMarker("Upload a **PDF**", 11, 14, "**")).toEqual({ value: "Upload a PDF", start: 9, end: 12 });
  });

  it("does not treat half of a bold pair as italic", () => {
    // "PDF" sits inside **...**: pressing italic adds italic rather than eating a star.
    expect(toggleMarker("a **PDF**", 4, 7, "*").value).toBe("a ***PDF***");
  });

  it("keeps spaces outside the markers", () => {
    expect(toggleMarker("say hello there", 3, 10, "==").value).toBe("say ==hello== there");
  });

  it("inserts a placeholder when nothing is selected", () => {
    expect(toggleMarker("Note: ", 6, 6, "**")).toEqual({ value: "Note: **bold text**", start: 8, end: 17 });
  });
});
