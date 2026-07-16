import { describe, expect, it } from "vitest";
import { countWords } from "./word-count-textarea";

describe("countWords", () => {
  it("counts zero for empty or whitespace-only input", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords(" \n\t ")).toBe(0);
  });

  it("counts whitespace-delimited words, collapsing runs of whitespace", () => {
    expect(countWords("hello")).toBe(1);
    expect(countWords("hello world")).toBe(2);
    expect(countWords("  hello   world  ")).toBe(2);
    expect(countWords("one\ntwo\tthree four")).toBe(4);
  });
});
