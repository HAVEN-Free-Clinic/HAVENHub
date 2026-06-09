import { describe, expect, it } from "vitest";
import { validateTemplate } from "./validate";

describe("validateTemplate", () => {
  it("passes when all variables are in the catalog and blocks balance", () => {
    const r = validateTemplate("Hi {{name}} {{#if dept}}{{dept}}{{/if}}", ["name", "dept"]);
    expect(r.ok).toBe(true);
    expect(r.unknownVariables).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("reports unknown variables (deduped)", () => {
    const r = validateTemplate("{{a}} {{b}} {{a}}", ["a"]);
    expect(r.ok).toBe(false);
    expect(r.unknownVariables).toEqual(["b"]);
  });

  it("reports an unclosed if block", () => {
    const r = validateTemplate("{{#if a}}x", ["a"]);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("1 unclosed {{#if}} block(s)");
  });

  it("reports a stray close", () => {
    const r = validateTemplate("x{{/if}}", []);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Unexpected {{/if}} without matching {{#if}}");
  });

  it("reports an else outside an if", () => {
    const r = validateTemplate("x{{else}}y", []);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("{{else}} outside of an {{#if}} block");
  });

  it("validates raw variables against the catalog too", () => {
    const r = validateTemplate("{{{ body }}}", ["body"]);
    expect(r.ok).toBe(true);
  });
});
