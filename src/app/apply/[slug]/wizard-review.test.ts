import { describe, expect, it } from "vitest";
import { formatFieldValue, reviewLabel } from "./wizard-review";
import type { WizardField } from "./wizard-steps";

const field = (o: Partial<WizardField> & { key: string; type: string }): WizardField => ({
  label: o.key, helpText: null, required: false, options: null, validation: null, ...o,
});

describe("formatFieldValue", () => {
  it("returns text values as-is and empty for missing", () => {
    expect(formatFieldValue(field({ key: "a", type: "TEXT" }), { a: "Ann" }, [])).toBe("Ann");
    expect(formatFieldValue(field({ key: "a", type: "TEXT" }), {}, [])).toBe("");
  });
  it("maps a single-select value to its option label", () => {
    const f = field({ key: "role", type: "SINGLE_SELECT", options: [{ value: "cv", label: "Clinical volunteer" }] });
    expect(formatFieldValue(f, { role: "cv" }, [])).toBe("Clinical volunteer");
  });
  it("joins multi-select labels with commas", () => {
    const f = field({ key: "days", type: "MULTI_SELECT", options: [{ value: "a", label: "Feb 7" }, { value: "b", label: "Feb 21" }] });
    expect(formatFieldValue(f, { days: ["a", "b"] }, [])).toBe("Feb 7, Feb 21");
  });
  it("renders a checkbox as Yes/No", () => {
    expect(formatFieldValue(field({ key: "ok", type: "CHECKBOX" }), { ok: "on" }, [])).toBe("Yes");
    expect(formatFieldValue(field({ key: "ok", type: "CHECKBOX" }), {}, [])).toBe("No");
  });
  it("resolves subcommittee ranks to names in order", () => {
    const f = field({ key: "rank", type: "SUBCOMMITTEE_RANK" });
    const subs = [{ id: "s1", name: "Outreach" }, { id: "s2", name: "Labs" }];
    expect(formatFieldValue(f, { rank: ["s2", "", "s1"] }, subs)).toBe("Labs › Outreach");
  });
  it("shows the file name or Not attached for FILE", () => {
    expect(formatFieldValue(field({ key: "cv", type: "FILE" }), { cv: "cv.pdf" }, [])).toBe("cv.pdf");
    expect(formatFieldValue(field({ key: "cv", type: "FILE" }), {}, [])).toBe("Not attached");
  });
  it("shows Signed for a non-empty SIGNATURE value and empty when unsigned", () => {
    const f = field({ key: "sig", type: "SIGNATURE" });
    expect(formatFieldValue(f, { sig: "data:image/png;base64,iVBORw0KGgo=" }, [])).toBe("Signed");
    expect(formatFieldValue(f, { sig: "" }, [])).toBe("");
    expect(formatFieldValue(f, {}, [])).toBe("");
  });
  it("renders an acknowledging NOTICE as Yes/No, like the checkbox it is", () => {
    const f = field({ key: "ai_use", type: "NOTICE", validation: { acknowledge: true } });
    expect(formatFieldValue(f, { ai_use: "on" }, [])).toBe("Yes");
    expect(formatFieldValue(f, {}, [])).toBe("No");
  });
});

describe("reviewLabel", () => {
  it("uses the field's own label for a question", () => {
    expect(reviewLabel(field({ key: "essay", type: "LONG_TEXT", label: "Why HAVEN?" }))).toBe("Why HAVEN?");
  });
  it("falls back to the confirmation text for a notice with no heading", () => {
    const f = field({ key: "ai_use", type: "NOTICE", label: "", validation: { acknowledge: true, acknowledgeLabel: "I understand" } });
    expect(reviewLabel(f)).toBe("I understand");
  });
});
