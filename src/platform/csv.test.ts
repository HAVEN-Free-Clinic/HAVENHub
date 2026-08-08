import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("joins plain fields without quoting", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsv(["name"], [["O'Brien, Jr."]])).toBe('name\r\n"O\'Brien, Jr."');
  });

  it("doubles and quotes an embedded double quote", () => {
    expect(toCsv(["name"], [['He said "hi"']])).toBe('name\r\n"He said ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsv(["note"], [["line one\nline two"]])).toBe('note\r\n"line one\nline two"');
  });

  it("quotes a field containing a carriage return", () => {
    expect(toCsv(["note"], [["a\rb"]])).toBe('note\r\n"a\rb"');
  });

  it("returns headers only for an empty row list", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b");
  });

  it("emits an empty field for a blank value rather than dropping the column", () => {
    expect(toCsv(["name", "email"], [["Jane", ""]])).toBe("name,email\r\nJane,");
  });
});
