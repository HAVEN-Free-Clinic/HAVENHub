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
