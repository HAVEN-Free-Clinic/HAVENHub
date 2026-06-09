import { describe, expect, it } from "vitest";
import { PERSON_VARIABLES, personVariables } from "./variables";

describe("person variables", () => {
  it("declares a campaign variable catalog", () => {
    expect(PERSON_VARIABLES.map((v) => v.name)).toEqual(["firstName", "name"]);
  });

  it("derives firstName from the first whitespace-separated token", () => {
    expect(personVariables({ name: "Jane Q Doe" })).toEqual({ firstName: "Jane", name: "Jane Q Doe" });
    expect(personVariables({ name: "" })).toEqual({ firstName: "", name: "" });
  });
});
