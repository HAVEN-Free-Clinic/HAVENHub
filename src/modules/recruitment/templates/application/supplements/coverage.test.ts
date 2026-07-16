import { describe, it, expect } from "vitest";
import { getApplicationTemplate } from "../../index";
import { SUPPLEMENT_DEPARTMENTS } from "./dept-codes";

const dates = [{ label: "May 30", value: "2026-05-30" }];

// Real HAVEN-authored labels legitimately contain phrases like "Supplement 1"
// or numbered supplement references (e.g. "SCTP / JCTP / SCTL Supplement 1"),
// so the placeholder guard below does NOT ban that substring. It only rejects
// content that is unmistakably a leftover stub: angle-bracket placeholders,
// "todo"/"tbd" markers, or a label too short to be real question text.
const PLACEHOLDER_PATTERN = /<.+>|todo|tbd/i;
const MIN_REAL_LABEL_LENGTH = 20;

describe("supplement coverage", () => {
  it("every SUPPLEMENT_DEPARTMENTS entry produces a non-empty supplement section", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const codes = SUPPLEMENT_DEPARTMENTS[track];
      const t = getApplicationTemplate(track, codes, dates);
      for (const code of codes) {
        const section = t.find((s) => s.departmentCode === code);
        expect(section, `${track} ${code} supplement section`).toBeDefined();
        expect(section!.fields.length, `${track} ${code} has questions`).toBeGreaterThan(0);
      }
    }
  });

  it("no field label or option is a leftover placeholder, and every label is real question text", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      const t = getApplicationTemplate(track, SUPPLEMENT_DEPARTMENTS[track], dates);
      for (const s of t.filter((section) => section.departmentCode !== null)) {
        for (const f of s.fields) {
          expect(f.label, `${track} ${s.departmentCode} field ${f.key}`).not.toMatch(PLACEHOLDER_PATTERN);
          expect(
            f.label.length,
            `${track} ${s.departmentCode} field ${f.key} label should be real question text: "${f.label}"`,
          ).toBeGreaterThan(MIN_REAL_LABEL_LENGTH);
          for (const o of f.options ?? []) expect(o.label).not.toMatch(PLACEHOLDER_PATTERN);
        }
      }
    }
  });
});
