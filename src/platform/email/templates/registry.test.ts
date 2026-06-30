import { describe, expect, it } from "vitest";
import { getDescriptor, listDescriptors, LAYOUT_KEY } from "./registry";

describe("template registry", () => {
  it("exposes the layout descriptor with a {{{ body }}} placeholder", () => {
    const layout = getDescriptor(LAYOUT_KEY);
    expect(layout).toBeDefined();
    expect(layout?.category).toBe("layout");
    expect(layout?.defaultBody).toContain("{{{ body }}}");
  });

  it("returns undefined for an unknown key", () => {
    expect(getDescriptor("does-not-exist")).toBeUndefined();
  });

  it("lists descriptors with unique keys", () => {
    const keys = listDescriptors().map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("template descriptors carry a group", () => {
  it("every descriptor has a group", () => {
    for (const d of listDescriptors()) {
      expect(d.group, `descriptor ${d.key} is missing a group`).toBeTruthy();
    }
  });

  it("recruitment descriptors are in the recruitment group", () => {
    const d = getDescriptor("recruitment.acceptance");
    expect(d?.group).toBe("recruitment");
  });

  it("compliance descriptors are in the compliance group", () => {
    const d = getDescriptor("compliance-reminder");
    expect(d?.group).toBe("compliance");
  });

  it("epic descriptors are in the epic group", () => {
    const d = getDescriptor("epic-onboarding");
    expect(d?.group).toBe("epic");
  });

  it("the layout descriptor is in the layout group", () => {
    const d = getDescriptor("layout");
    expect(d?.group).toBe("layout");
  });
});
