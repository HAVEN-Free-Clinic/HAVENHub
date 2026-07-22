import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemFieldCard } from "./system-field-card";
import type { SystemFieldBlock } from "@/modules/recruitment/contract/layout";
import type { SortableHandleProps } from "../sortable-list";

const fieldOptions = [{ value: "department", label: "Department" }];

const handle: SortableHandleProps = { attributes: {}, listeners: undefined, isDragging: false };

function renderCard(systemKey: SystemFieldBlock["systemKey"]) {
  const block: SystemFieldBlock = { kind: "system_field", systemKey };
  return renderToStaticMarkup(
    <SystemFieldCard block={block} handle={handle} fieldOptions={fieldOptions} onUpdate={() => {}} onToggle={() => {}} />
  );
}

describe("SystemFieldCard", () => {
  it("does not render the condition-editor affordance for a CORE field", () => {
    const out = renderCard("hipaa");
    expect(out).not.toContain("Always shown");
    expect(out).not.toContain("Add condition");
  });

  it("does not render the condition-editor affordance for the other CORE fields either", () => {
    const out = renderCard("email");
    expect(out).not.toContain("Always shown");
    expect(out).not.toContain("Add condition");
  });

  it("renders the condition-editor affordance for a non-core field", () => {
    const out = renderCard("netId");
    expect(out).toMatch(/Always shown|Add condition/);
  });

  it("renders the condition-editor affordance for another non-core field", () => {
    const out = renderCard("pronouns");
    expect(out).toMatch(/Always shown|Add condition/);
  });
});
