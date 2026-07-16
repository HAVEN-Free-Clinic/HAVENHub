import { describe, expect, it } from "vitest";
import { validateAvs } from "./validate";
import { initialAvsData } from "./form-state";

const valid = { ...initialAvsData, lastName: "Doe", visitDate: "2026-07-15", primaryReason: "Checkup" };

describe("validateAvs", () => {
  it("passes a complete form with no medications", () => {
    expect(validateAvs(valid).messages).toEqual([]);
  });

  it("requires last name, visit date, and reason", () => {
    const { messages, fields } = validateAvs(initialAvsData);
    expect(fields).toEqual(["lastName", "visitDate", "primaryReason"]);
    expect(messages).toHaveLength(3);
  });

  it("flags a medication with a dose but no name (audit #13)", () => {
    const data = { ...valid, medications: [{ name: "  ", dose: "10mg", costSource: "" }] };
    expect(validateAvs(data).messages.some((m) => /Medication 1/.test(m))).toBe(true);
  });

  it("flags a medication with a cost source but no name (audit #13)", () => {
    const data = { ...valid, medications: [{ name: "", dose: "", costSource: "GoodRx" }] };
    expect(validateAvs(data).messages.some((m) => /Medication 1/.test(m))).toBe(true);
  });

  it("does not flag a fully-blank medication row (nothing to lose)", () => {
    const data = { ...valid, medications: [{ name: "", dose: "", costSource: "" }] };
    expect(validateAvs(data).messages).toEqual([]);
  });

  it("does not flag a named medication", () => {
    const data = { ...valid, medications: [{ name: "Metformin", dose: "500mg", costSource: "" }] };
    expect(validateAvs(data).messages).toEqual([]);
  });
});
