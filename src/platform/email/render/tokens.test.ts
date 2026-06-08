import { describe, expect, it } from "vitest";
import { tokenize } from "./tokens";

describe("tokenize", () => {
  it("splits literal text and a variable", () => {
    expect(tokenize("Hi {{ name }}!")).toEqual([
      { type: "text", value: "Hi " },
      { type: "var", name: "name" },
      { type: "text", value: "!" },
    ]);
  });

  it("recognizes raw (triple-brace) variables", () => {
    expect(tokenize("{{{ body }}}")).toEqual([{ type: "rawVar", name: "body" }]);
  });

  it("recognizes if/else/close control tags", () => {
    expect(tokenize("{{#if x}}a{{else}}b{{/if}}")).toEqual([
      { type: "ifOpen", name: "x" },
      { type: "text", value: "a" },
      { type: "else" },
      { type: "text", value: "b" },
      { type: "ifClose" },
    ]);
  });

  it("trims whitespace inside tags", () => {
    expect(tokenize("{{   name   }}")).toEqual([{ type: "var", name: "name" }]);
  });

  it("returns a single text token when there are no tags", () => {
    expect(tokenize("plain")).toEqual([{ type: "text", value: "plain" }]);
  });
});
