import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConditionEditor } from "./condition-editor";

const fields = [{ value: "department", label: "Department" }, { value: "track", label: "Track" }];

describe("ConditionEditor", () => {
  it("reads as always shown when there is no condition", () => {
    const out = renderToStaticMarkup(<ConditionEditor value={undefined} onChange={() => {}} fieldOptions={fields} />);
    expect(out).toContain("Always shown");
    expect(out).toContain("Add condition");
  });

  it("renders the field, operator and value controls for a condition", () => {
    const out = renderToStaticMarkup(
      <ConditionEditor value={{ field: "department", op: "is", value: "BVHD" }} onChange={() => {}} fieldOptions={fields} />
    );
    expect(out).toContain("Department");
    expect(out).toContain("BVHD");
    expect(out).toContain("Remove condition");
  });

  it("hides the value control for isAnswered", () => {
    const out = renderToStaticMarkup(
      <ConditionEditor value={{ field: "department", op: "isAnswered" }} onChange={() => {}} fieldOptions={fields} />
    );
    expect(out).not.toContain("Value");
  });

  it("shows an existing isAnyOf condition's array value and operator instead of blanking it", () => {
    const out = renderToStaticMarkup(
      <ConditionEditor
        value={{ field: "department", op: "isAnyOf", value: ["BVHD", "MDIC"] }}
        onChange={() => {}}
        fieldOptions={fields}
      />
    );
    expect(out).toContain("BVHD, MDIC");
    expect(out).toContain("is any of");
  });
});
