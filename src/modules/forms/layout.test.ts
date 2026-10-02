import { describe, expect, it } from "vitest";
import { FormLayoutError, keyFromLabel, parseFormLayout, validateAnswers, type FormLayout } from "./layout";
import { FORM_TEMPLATES } from "./templates";

const LAYOUT: FormLayout = {
  questions: [
    { key: "name", type: "short_text", label: "Name", required: true },
    { key: "abroad", type: "single_choice", label: "Abroad?", options: ["Yes", "No"], required: true },
    {
      key: "where",
      type: "short_text",
      label: "Where?",
      required: true,
      visibleWhen: { field: "abroad", op: "is", value: "Yes" },
    },
    { key: "s1", type: "section", label: "More" },
    { key: "likes", type: "multi_choice", label: "Likes", options: ["A", "B"], allowOther: true },
    { key: "score", type: "rating", label: "Score", scale: { max: 5 } },
  ],
};

describe("parseFormLayout", () => {
  it("accepts every starter template", () => {
    for (const t of FORM_TEMPLATES) expect(() => parseFormLayout(t.layout)).not.toThrow();
  });

  it("refuses duplicate keys, optionless choices, and conditions on later questions", () => {
    const err = (() => {
      try {
        parseFormLayout({
          questions: [
            { key: "a", type: "short_text", label: "A", visibleWhen: { field: "b", op: "isAnswered" } },
            { key: "b", type: "single_choice", label: "B", options: [] },
            { key: "b", type: "short_text", label: "B again" },
          ],
        });
      } catch (e) {
        return e as FormLayoutError;
      }
    })();
    expect(err).toBeInstanceOf(FormLayoutError);
    expect(err!.problems).toEqual([
      '"A" depends on a question that is not above it.',
      '"B" needs at least one option.',
      'Two questions share the key "b".',
    ]);
  });

  it("refuses a malformed key", () => {
    expect(() => parseFormLayout({ questions: [{ key: "Bad Key", type: "short_text", label: "x" }] })).toThrow(
      FormLayoutError,
    );
  });
});

describe("validateAnswers", () => {
  it("enforces required visible questions and skips hidden ones", () => {
    expect(validateAnswers(LAYOUT, { abroad: "No" }).problems).toEqual(['Answer "Name".']);
    expect(validateAnswers(LAYOUT, { name: "Sam", abroad: "Yes" }).problems).toEqual(['Answer "Where?".']);
  });

  it("drops an answer to a question the respondent hid again", () => {
    const { answers, problems } = validateAnswers(LAYOUT, { name: "Sam", abroad: "No", where: "Peru" });
    expect(problems).toEqual([]);
    expect(answers).toEqual({ name: "Sam", abroad: "No" });
  });

  it("refuses values outside the options, and accepts a written-in Other", () => {
    expect(validateAnswers(LAYOUT, { name: "Sam", abroad: "Maybe" }).problems).toEqual([
      'Pick one of the listed options for "Abroad?".',
    ]);
    expect(validateAnswers(LAYOUT, { name: "Sam", abroad: "No", likes: ["A", "Z"] }).problems).toHaveLength(1);
    const ok = validateAnswers(LAYOUT, { name: "Sam", abroad: "No", likes: ["A", "Other: Hiking", "A"] });
    expect(ok.answers.likes).toEqual(["A", "Other: Hiking"]);
  });

  it("bounds a rating to its scale", () => {
    expect(validateAnswers(LAYOUT, { name: "Sam", abroad: "No", score: "6" }).problems).toEqual([
      'Rate "Score" from 1 to 5.',
    ]);
    expect(validateAnswers(LAYOUT, { name: "Sam", abroad: "No", score: "4" }).answers.score).toBe("4");
  });
});

describe("keyFromLabel", () => {
  it("slugs a label and keeps keys unique", () => {
    const taken = new Set(["how_satisfied_are_you"]);
    expect(keyFromLabel("How satisfied are you?", taken)).toBe("how_satisfied_are_you_2");
    expect(keyFromLabel("!!!", new Set())).toBe("question");
  });
});
