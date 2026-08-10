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

describe("toCsv formula injection guard (opts.neutralizeFormulas)", () => {
  it.each([
    ["=", "=cmd", "'=cmd"],
    ["+", "+cmd", "'+cmd"],
    ["-", "-cmd", "'-cmd"],
    ["@", "@cmd", "'@cmd"],
    ["tab", "\tcmd", "'\tcmd"],
  ])("prefixes a single quote onto a field starting with %s", (_label, value, expectedField) => {
    // None of these contain a comma or double quote, so RFC 4180 quoting
    // never kicks in on top of the neutralizing prefix -- the whole point is
    // to see the bare "'..." shape land in the output.
    expect(toCsv(["name"], [[value]], { neutralizeFormulas: true })).toBe(`name\r\n${expectedField}`);
  });

  it("prefixes a single quote onto a field starting with CR, which also forces RFC 4180 quoting", () => {
    // A leading CR is both a dangerous leading character and, once
    // prefixed, still contains the CR that triggers ordinary RFC 4180
    // quoting, so the neutralized field comes back quoted.
    expect(toCsv(["name"], [["\rcmd"]], { neutralizeFormulas: true })).toBe('name\r\n"\'\rcmd"');
  });

  it("neutralizes a realistic HYPERLINK injection, still doubling the embedded quotes", () => {
    const value = '=HYPERLINK("http://evil/","click")';
    expect(toCsv(["name"], [[value]], { neutralizeFormulas: true })).toBe(
      'name\r\n"\'=HYPERLINK(""http://evil/"",""click"")"',
    );
  });

  it("leaves a dangerous leading character untouched when the option is off", () => {
    expect(toCsv(["name"], [["=cmd"]])).toBe("name\r\n=cmd");
  });

  it("leaves a normal field alone when the option is on", () => {
    expect(toCsv(["name"], [["Jane Doe"]], { neutralizeFormulas: true })).toBe("name\r\nJane Doe");
  });
});
