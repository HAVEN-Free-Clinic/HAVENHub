import { describe, expect, it } from "vitest";
import { recruitmentDescriptors } from "./recruitment";
import { getDescriptor, listDescriptors } from "./registry";
import { renderTemplate } from "@/platform/email/render/render";
import { validateTemplate } from "@/platform/email/render/validate";

const KEYS = [
  "recruitment.acceptance",
  "recruitment.interview_invite",
  "recruitment.onboarding",
  "recruitment.application_received",
  "recruitment.portal_link",
];

describe("recruitment email descriptors", () => {
  it("exports all five keys", () => {
    expect(recruitmentDescriptors.map((d) => d.key).sort()).toEqual([...KEYS].sort());
  });

  it("registers them in the shared registry", () => {
    for (const key of KEYS) expect(getDescriptor(key)?.key).toBe(key);
    const all = listDescriptors().map((d) => d.key);
    for (const key of KEYS) expect(all).toContain(key);
  });

  it("each default subject and body uses only declared variables", () => {
    for (const d of recruitmentDescriptors) {
      const allowed = d.variables.map((v) => v.name);
      expect(validateTemplate(d.defaultSubject, allowed).ok).toBe(true);
      expect(validateTemplate(d.defaultBody, allowed).ok).toBe(true);
    }
  });

  it("renders each default body with sample values without leftover tags", () => {
    for (const d of recruitmentDescriptors) {
      const ctx: Record<string, unknown> = {};
      for (const v of d.variables) ctx[v.name] = v.sampleValue;
      const out = renderTemplate(d.defaultBody, ctx);
      expect(out).not.toContain("{{");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("escapes interpolated values but renders joinLink raw", () => {
    const invite = getDescriptor("recruitment.interview_invite")!;
    const out = renderTemplate(invite.defaultBody, {
      firstName: "<script>x</script>",
      departmentName: "R & D",
      interviewTime: "Monday",
      joinLink: '<a href="https://z">https://z</a>',
    });
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("R &amp; D");
    expect(out).toContain('<a href="https://z">');
  });
});
