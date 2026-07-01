import { expect, it } from "vitest";
import { appendChoice, renameChoice } from "./options";

it("derives a slugged value when appending", () => {
  const out = appendChoice([], "Patient health information");
  expect(out).toEqual([{ value: "patient_health_information", label: "Patient health information" }]);
});

it("keeps appended values unique", () => {
  let opts = appendChoice([], "Yes");
  opts = appendChoice(opts, "Yes");
  expect(opts.map((o) => o.value)).toEqual(["yes", "yes_2"]);
});

it("rename changes the label but never the value", () => {
  const opts = appendChoice([], "Hopsital revenue"); // typo
  const fixed = renameChoice(opts, "hopsital_revenue", "Hospital revenue");
  expect(fixed).toEqual([{ value: "hopsital_revenue", label: "Hospital revenue" }]);
});
