import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACKNOWLEDGE_LABEL,
  isDisplayOnlyNotice,
  noticeAcknowledgeLabel,
  noticeDisplayLabel,
} from "./notice";

describe("noticeAcknowledgeLabel", () => {
  it("returns null for a notice that does not ask to be acknowledged", () => {
    expect(noticeAcknowledgeLabel(null)).toBeNull();
    expect(noticeAcknowledgeLabel({})).toBeNull();
    expect(noticeAcknowledgeLabel({ acknowledge: false })).toBeNull();
  });

  it("falls back to the default text when acknowledgement is on with no custom label", () => {
    expect(noticeAcknowledgeLabel({ acknowledge: true })).toBe(DEFAULT_ACKNOWLEDGE_LABEL);
    // A label the author blanked out must not render an empty checkbox caption.
    expect(noticeAcknowledgeLabel({ acknowledge: true, acknowledgeLabel: "   " })).toBe(DEFAULT_ACKNOWLEDGE_LABEL);
  });

  it("returns the custom confirmation text when one is set", () => {
    expect(noticeAcknowledgeLabel({ acknowledge: true, acknowledgeLabel: "I understand" })).toBe("I understand");
  });

  it("tolerates the junk shapes the untyped JSON column can hold", () => {
    expect(noticeAcknowledgeLabel(undefined)).toBeNull();
    expect(noticeAcknowledgeLabel("acknowledge")).toBeNull();
    expect(noticeAcknowledgeLabel([{ acknowledge: true }])).toBeNull();
    // acknowledge must be the boolean true, not merely truthy: a stray string
    // would otherwise switch a notice into asking for an answer nobody authored.
    expect(noticeAcknowledgeLabel({ acknowledge: "yes" })).toBeNull();
  });
});

describe("isDisplayOnlyNotice", () => {
  it("is true for a notice with no acknowledgement", () => {
    expect(isDisplayOnlyNotice({ type: "NOTICE", validation: null })).toBe(true);
  });

  it("is false for a notice that carries an acknowledgement tick", () => {
    expect(isDisplayOnlyNotice({ type: "NOTICE", validation: { acknowledge: true } })).toBe(false);
  });

  it("is false for every other field type, so it is safe over a mixed list", () => {
    expect(isDisplayOnlyNotice({ type: "LONG_TEXT", validation: null })).toBe(false);
    expect(isDisplayOnlyNotice({ type: "CHECKBOX", validation: { acknowledge: true } })).toBe(false);
    expect(isDisplayOnlyNotice({ type: "FILE" })).toBe(false);
  });
});

describe("noticeDisplayLabel", () => {
  it("prefers the authored heading", () => {
    expect(noticeDisplayLabel({ label: "AI use", validation: { acknowledge: true } })).toBe("AI use");
  });

  it("falls back to the confirmation text, since a heading is optional", () => {
    expect(noticeDisplayLabel({ label: "", validation: { acknowledge: true, acknowledgeLabel: "I understand" } }))
      .toBe("I understand");
    expect(noticeDisplayLabel({ label: "  ", validation: { acknowledge: true } })).toBe(DEFAULT_ACKNOWLEDGE_LABEL);
  });

  it("falls back to the type name when there is neither", () => {
    expect(noticeDisplayLabel({ label: "", validation: null })).toBe("Notice");
  });
});
