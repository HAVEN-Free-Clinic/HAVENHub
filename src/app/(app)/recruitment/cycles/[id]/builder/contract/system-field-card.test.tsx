import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemFieldCard } from "./system-field-card";
import type { SystemFieldBlock } from "@/modules/recruitment/contract/layout";
import type { SortableHandleProps } from "../sortable-list";

const fieldOptions = [{ value: "department", label: "Department" }];

const handle: SortableHandleProps = { attributes: {}, listeners: undefined, isDragging: false };

function renderCard(systemKey: SystemFieldBlock["systemKey"], extra: Partial<SystemFieldBlock> = {}) {
  const block: SystemFieldBlock = { kind: "system_field", systemKey, ...extra };
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

describe("SystemFieldCard required switch", () => {
  /** The checkbox input immediately wrapping-label-adjacent to "Required". */
  const requiredInput = (out: string) => out.match(/<input[^>]*>(?=(?:(?!<input).)*Required)/s)?.[0] ?? null;

  it("offers a Required switch on an optional field, reflecting the field's default", () => {
    const photo = renderCard("photo");
    expect(photo).toContain("Required");
    expect(requiredInput(photo)).toMatch(/checked=""/);
    const phone = renderCard("phone");
    expect(requiredInput(phone)).not.toMatch(/checked=""/);
  });

  it("reflects a director's choice over the default", () => {
    expect(requiredInput(renderCard("photo", { required: false }))).not.toMatch(/checked=""/);
    expect(requiredInput(renderCard("phone", { required: true }))).toMatch(/checked=""/);
  });

  it("has no Required switch on a locked field or a yes/no checkbox field", () => {
    expect(renderCard("hipaa")).not.toContain(">Required<");
    expect(renderCard("licensedRN")).not.toContain(">Required<");
  });
});
