import { describe, expect, it } from "vitest";
import { derivedAnswer, derivedAnswers, fieldDerivation } from "./haven-history";

const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const BOARD = [
  { value: "yes_term_extension", label: "Yes - Term Extension" },
  { value: "yes_new_position", label: "Yes - New Position" },
  { value: "no", label: "No" },
];
const volunteerQ = { key: "prev_volunteered", type: "SINGLE_SELECT", options: YES_NO, validation: { derive: "haven_volunteer_history" } };
const boardQ = { key: "returning_board", type: "SINGLE_SELECT", options: BOARD, validation: { derive: "haven_board_history" } };

describe("fieldDerivation", () => {
  it("reads only the known markers", () => {
    expect(fieldDerivation({ derive: "haven_volunteer_history" })).toBe("haven_volunteer_history");
    expect(fieldDerivation({ derive: "haven_board_history" })).toBe("haven_board_history");
    expect(fieldDerivation({ derive: "something_else" })).toBeNull();
    expect(fieldDerivation(null)).toBeNull();
  });
});

describe("volunteer history", () => {
  it("is yes with any volunteer or director membership and no with neither", () => {
    expect(derivedAnswer(volunteerQ, { volunteered: true, directed: false }, "NEW")).toBe("yes");
    // Serving on the Board is serving at HAVEN: a sitting director who never held
    // a volunteer membership must not read "never volunteered" to reviewers.
    expect(derivedAnswer(volunteerQ, { volunteered: false, directed: true }, "NEW")).toBe("yes");
    expect(derivedAnswer(volunteerQ, { volunteered: false, directed: false }, "NEW")).toBe("no");
  });
});

describe("board history", () => {
  it("is a term extension for a renewing director", () => {
    expect(derivedAnswer(boardQ, { volunteered: true, directed: true }, "RENEWAL")).toBe("yes_term_extension");
  });
  it("is a new position for a past director applying as NEW or TRANSFER", () => {
    expect(derivedAnswer(boardQ, { volunteered: false, directed: true }, "NEW")).toBe("yes_new_position");
    expect(derivedAnswer(boardQ, { volunteered: false, directed: true }, "TRANSFER")).toBe("yes_new_position");
  });
  it("is no without director history", () => {
    expect(derivedAnswer(boardQ, { volunteered: true, directed: false }, "NEW")).toBe("no");
  });
});

describe("guards", () => {
  it("does not derive when the field's options cannot carry the answer", () => {
    const relabelled = { ...volunteerQ, options: [{ value: "y", label: "Yes" }, { value: "n", label: "No" }] };
    expect(derivedAnswer(relabelled, { volunteered: true, directed: false }, "NEW")).toBeNull();
    const noExtension = { ...boardQ, options: BOARD.filter((o) => o.value !== "yes_term_extension") };
    expect(derivedAnswer(noExtension, { volunteered: true, directed: true }, "RENEWAL")).toBeNull();
    expect(derivedAnswer(noExtension, { volunteered: true, directed: false }, "RENEWAL")).toBe("no");
  });
  it("ignores fields with no marker, and non-select fields with one", () => {
    expect(derivedAnswer({ ...volunteerQ, validation: null }, { volunteered: true, directed: true }, "NEW")).toBeNull();
    expect(derivedAnswer({ ...volunteerQ, type: "SHORT_TEXT" }, { volunteered: true, directed: true }, "NEW")).toBeNull();
  });
  it("collects every derived answer by key", () => {
    const other = { key: "essay", type: "LONG_TEXT", options: null, validation: null };
    expect(derivedAnswers([volunteerQ, boardQ, other], { volunteered: true, directed: false }, "NEW")).toEqual({
      prev_volunteered: "yes",
      returning_board: "no",
    });
  });
});
