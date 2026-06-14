import { describe, expect, it } from "vitest";
import { avsReducer, initialAvsData } from "./form-state";

describe("avsReducer", () => {
  it("sets a string field", () => {
    const s = avsReducer(initialAvsData, { type: "setField", key: "lastName", value: "Garcia" });
    expect(s.lastName).toBe("Garcia");
  });

  it("sets the language", () => {
    expect(avsReducer(initialAvsData, { type: "setLang", value: "es" }).preferredLang).toBe("es");
  });

  it("toggles an array value on and off", () => {
    const on = avsReducer(initialAvsData, { type: "toggle", key: "vitals", value: "blood-pressure" });
    expect(on.vitals).toEqual(["blood-pressure"]);
    const off = avsReducer(on, { type: "toggle", key: "vitals", value: "blood-pressure" });
    expect(off.vitals).toEqual([]);
  });

  it("adds, updates, and removes medications", () => {
    const a = avsReducer(initialAvsData, { type: "addMed" });
    expect(a.medications).toHaveLength(1);
    const b = avsReducer(a, { type: "updateMed", index: 0, key: "name", value: "Lisinopril" });
    expect(b.medications[0].name).toBe("Lisinopril");
    const c = avsReducer(b, { type: "removeMed", index: 0 });
    expect(c.medications).toHaveLength(0);
  });

  it("adds, updates, and removes action items", () => {
    const a = avsReducer(initialAvsData, { type: "addActionItem" });
    expect(a.actionItems).toEqual([""]);
    const b = avsReducer(a, { type: "updateActionItem", index: 0, value: "Walk daily" });
    expect(b.actionItems).toEqual(["Walk daily"]);
    const c = avsReducer(b, { type: "removeActionItem", index: 0 });
    expect(c.actionItems).toEqual([]);
  });

  it("does not mutate the previous state", () => {
    const next = avsReducer(initialAvsData, { type: "addMed" });
    expect(initialAvsData.medications).toHaveLength(0);
    expect(next).not.toBe(initialAvsData);
  });
});
