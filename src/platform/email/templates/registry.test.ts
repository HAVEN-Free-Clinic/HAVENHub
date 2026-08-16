import { describe, expect, it } from "vitest";
import { validateTemplate } from "@/platform/email/render/validate";
import { renderTemplate } from "@/platform/email/render/render";
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

// ---------------------------------------------------------------------------
// Variable guard, driven off the registry (audit 14, TSI-05)
//
// renderTemplate resolves an undeclared {{ name }} to the empty string and the
// send path never throws, so a mistyped or renamed variable ships as a blank
// line in a real email with nothing logged. The only thing standing between
// that and production is this check.
//
// It used to run off hand-maintained key lists in schedule.test.ts,
// recruitment.test.ts and shift.test.ts, which between them named 19 of the 46
// registered descriptors -- and schedule's list had already drifted, omitting
// its own schedule-request-denied-partner. Every incidents, support, epic,
// clearance, compliance, auth, attending and volunteers template was unguarded.
// Iterating listDescriptors() means a template is covered the moment it is
// registered, which is the only step a new template cannot skip.
// ---------------------------------------------------------------------------

const DESCRIPTOR_KEYS = listDescriptors().map((d) => d.key);

describe("every registered descriptor declares the variables it uses", () => {
  it("walks the whole registry, not a handful of templates", () => {
    // A collapsed registry would make every case below vacuously pass.
    expect(DESCRIPTOR_KEYS.length).toBeGreaterThan(40);
  });

  it.each(DESCRIPTOR_KEYS)("%s: subject references only declared variables", (key) => {
    const d = getDescriptor(key)!;
    const allowed = d.variables.map((v) => v.name);
    const result = validateTemplate(d.defaultSubject, allowed);
    expect(result.unknownVariables).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it.each(DESCRIPTOR_KEYS)("%s: body references only declared variables", (key) => {
    const d = getDescriptor(key)!;
    const allowed = d.variables.map((v) => v.name);
    const result = validateTemplate(d.defaultBody, allowed);
    expect(result.unknownVariables).toEqual([]);
    // Also catches an unclosed or stray {{#if}}, which renders as literal text.
    expect(result.errors).toEqual([]);
  });

  it.each(DESCRIPTOR_KEYS)("%s: renders with its own sample values, leaving no tags", (key) => {
    const d = getDescriptor(key)!;
    const ctx: Record<string, unknown> = {};
    for (const v of d.variables) ctx[v.name] = v.sampleValue;
    // The admin preview renders exactly this way, so a leftover "{{" here is a
    // tag an admin would see verbatim in the template editor's preview pane.
    expect(renderTemplate(d.defaultBody, ctx)).not.toContain("{{");
  });
});
