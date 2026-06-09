import { describe, expect, it } from "vitest";
import { renderTemplate } from "./render";

describe("renderTemplate", () => {
  it("substitutes and HTML-escapes variables", () => {
    expect(renderTemplate("Hi {{ name }}", { name: "<b>A&B</b>" })).toBe(
      "Hi &lt;b&gt;A&amp;B&lt;/b&gt;",
    );
  });

  it("does not escape raw (triple-brace) variables", () => {
    expect(renderTemplate("{{{ body }}}", { body: "<p>hi</p>" })).toBe("<p>hi</p>");
  });

  it("renders missing variables as empty string", () => {
    expect(renderTemplate("a{{ missing }}b", {})).toBe("ab");
  });

  it("renders the consequent when the condition is truthy", () => {
    expect(renderTemplate("{{#if x}}YES{{else}}NO{{/if}}", { x: "v" })).toBe("YES");
  });

  it("renders the alternate when the condition is falsy", () => {
    expect(renderTemplate("{{#if x}}YES{{else}}NO{{/if}}", { x: "" })).toBe("NO");
  });

  it("treats empty string, 0, false, null, undefined as falsy", () => {
    const t = "{{#if x}}Y{{/if}}";
    expect(renderTemplate(t, { x: "" })).toBe("");
    expect(renderTemplate(t, { x: 0 })).toBe("");
    expect(renderTemplate(t, { x: false })).toBe("");
    expect(renderTemplate(t, { x: null })).toBe("");
    expect(renderTemplate(t, {})).toBe("");
    expect(renderTemplate(t, { x: "ok" })).toBe("Y");
  });

  it("supports nested conditionals", () => {
    const t = "{{#if a}}A{{#if b}}B{{/if}}{{/if}}";
    expect(renderTemplate(t, { a: true, b: true })).toBe("AB");
    expect(renderTemplate(t, { a: true, b: false })).toBe("A");
    expect(renderTemplate(t, { a: false, b: true })).toBe("");
  });

  it("renders an if-block with no else when truthy and falsy", () => {
    expect(renderTemplate("x{{#if a}}Y{{/if}}z", { a: true })).toBe("xYz");
    expect(renderTemplate("x{{#if a}}Y{{/if}}z", { a: false })).toBe("xz");
  });
});
