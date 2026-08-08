import { describe, it, expect } from "vitest";
import { resolveCustomAnswers } from "./custom-answers";

const snapshot = {
  blocks: [
    { kind: "custom_question", key: "tshirt", label: "T-shirt size", type: "SHORT_TEXT", required: false },
    { kind: "agreement", id: "strike_policy", title: "Strikes", body: "x", confirmKind: "checkbox", signatureLabel: "confirm" },
  ],
};

describe("resolveCustomAnswers", () => {
  it("labels a custom question from the snapshot", () => {
    expect(resolveCustomAnswers(snapshot, { tshirt: "M" })).toEqual([
      { label: "T-shirt size", value: "M" },
    ]);
  });

  it("drops internal agreement-confirmation keys", () => {
    expect(resolveCustomAnswers(snapshot, { confirm__strike_policy: "on" })).toEqual([]);
  });

  it("drops an answer to a question the snapshot never showed", () => {
    expect(resolveCustomAnswers(snapshot, { removed_question: "stale" })).toEqual([]);
  });

  it("joins a multi-value answer", () => {
    expect(resolveCustomAnswers(snapshot, { tshirt: ["M", "L"] })).toEqual([
      { label: "T-shirt size", value: "M, L" },
    ]);
  });

  it("drops empty and nullish answers", () => {
    expect(resolveCustomAnswers(snapshot, { tshirt: "" })).toEqual([]);
    expect(resolveCustomAnswers(snapshot, { tshirt: null })).toEqual([]);
  });

  it("returns nothing when the snapshot is missing or invalid", () => {
    expect(resolveCustomAnswers(null, { tshirt: "M" })).toEqual([]);
    expect(resolveCustomAnswers({ nope: true }, { tshirt: "M" })).toEqual([]);
  });
});
