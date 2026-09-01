import { describe, it, expect } from "vitest";
import { formatAnswer, labelFor, parseOptions, storedFileRef, type DisplayField } from "./answer-display";
import { LANGUAGES_FIELD_KEY } from "@/platform/languages/catalog";

const field = (f: Partial<DisplayField> & Pick<DisplayField, "type">): DisplayField => ({
  key: "q",
  options: null,
  ...f,
});

describe("parseOptions / labelFor", () => {
  it("keeps only well-formed choices", () => {
    expect(parseOptions([{ value: "a", label: "A" }, { value: 1 }, null, "x"])).toEqual([{ value: "a", label: "A" }]);
    expect(parseOptions(null)).toEqual([]);
  });

  it("falls back to the raw value for an option that no longer exists", () => {
    expect(labelFor([{ value: "a", label: "A" }], "gone")).toBe("gone");
  });
});

describe("formatAnswer", () => {
  it("resolves a single-select to its option label", () => {
    const f = field({
      type: "SINGLE_SELECT",
      key: "yale_affiliation",
      options: [{ value: "yale_college", label: "Yale College" }],
    });
    expect(formatAnswer(f, "yale_college")).toBe("Yale College");
  });

  it("resolves builder-generated option keys", () => {
    // The form builder seeds a new choice as "Option 3" and keeps that value
    // when the author renames the label, so the stored answer is "option_3".
    const f = field({ type: "SINGLE_SELECT", options: [{ value: "option_3", label: "Yes, dermatology" }] });
    expect(formatAnswer(f, "option_3")).toBe("Yes, dermatology");
  });

  it("resolves every value of a multi-select", () => {
    const f = field({
      type: "MULTI_SELECT",
      options: [
        { value: "RN", label: "RN (Registered Nurse)" },
        { value: "EMT", label: "EMT (Emergency Medical Technician)" },
      ],
    });
    expect(formatAnswer(f, ["RN", "EMT"])).toBe("RN (Registered Nurse), EMT (Emergency Medical Technician)");
  });

  it("names a language whose option list has drifted", () => {
    const f = field({ type: "MULTI_SELECT", key: LANGUAGES_FIELD_KEY, options: [] });
    expect(formatAnswer(f, ["zh", "pt"])).toBe("Chinese, Portuguese");
  });

  it("reads a checkbox as yes/no, and leaves an untouched one unanswered", () => {
    const f = field({ type: "CHECKBOX" });
    expect(formatAnswer(f, true)).toBe("Yes");
    expect(formatAnswer(f, false)).toBe("No");
    expect(formatAnswer(f, "on")).toBe("Yes");
    expect(formatAnswer(f, undefined)).toBe("");
  });

  it("reads an acknowledging notice the same way", () => {
    expect(formatAnswer(field({ type: "NOTICE" }), true)).toBe("Yes");
  });

  it("renders a date answer as a calendar day", () => {
    expect(formatAnswer(field({ type: "DATE" }), "2026-10-17")).toBe("Oct 17, 2026");
  });

  it("leaves an unparseable date as stored", () => {
    expect(formatAnswer(field({ type: "DATE" }), "sometime")).toBe("sometime");
  });

  it("names a stored file rather than rendering [object Object]", () => {
    const f = field({ type: "FILE" });
    expect(formatAnswer(f, { storedName: "abc.pdf", fileName: "Resume.pdf" })).toBe("Resume.pdf");
    expect(formatAnswer(f, { storedName: "abc.pdf" })).toBe("(file)");
  });

  it("returns empty for every shape of unanswered", () => {
    const f = field({ type: "SHORT_TEXT" });
    expect(formatAnswer(f, undefined)).toBe("");
    expect(formatAnswer(f, null)).toBe("");
    expect(formatAnswer(f, "")).toBe("");
    expect(formatAnswer(field({ type: "MULTI_SELECT" }), [])).toBe("");
  });

  it("leaves free text exactly as typed", () => {
    const f = field({ type: "LONG_TEXT" });
    expect(formatAnswer(f, "andy_told_me to apply")).toBe("andy_told_me to apply");
  });

  it("humanizes a choice value whose option list is missing", () => {
    expect(formatAnswer(field({ type: "SINGLE_SELECT" }), "fluent_non_native")).toBe("Fluent Non Native");
    expect(formatAnswer(field({ type: "SINGLE_SELECT" }), "yes")).toBe("Yes");
  });

  it("leaves a department code alone", () => {
    expect(formatAnswer(field({ type: "DEPARTMENT_CHOICE" }), "SCTP")).toBe("SCTP");
  });
});

describe("storedFileRef", () => {
  it("recognizes only a real blob ref", () => {
    expect(storedFileRef({ storedName: "a", fileName: "b.pdf" })).toEqual({ storedName: "a", fileName: "b.pdf" });
    expect(storedFileRef({ fileName: "b.pdf" })).toBeNull();
    expect(storedFileRef("a")).toBeNull();
    expect(storedFileRef(["a"])).toBeNull();
    expect(storedFileRef(null)).toBeNull();
  });
});
