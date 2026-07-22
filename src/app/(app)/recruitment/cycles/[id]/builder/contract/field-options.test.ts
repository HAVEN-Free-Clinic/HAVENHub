import { describe, it, expect } from "vitest";
import { buildFieldOptions } from "./field-options";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

describe("buildFieldOptions", () => {
  it("always offers the three authoritative context keys", () => {
    const layout: ContractLayout = { blocks: [] };
    const values = buildFieldOptions(layout).map((o) => o.value);
    expect(values).toEqual(["department", "track", "epicRequirement"]);
  });

  it("offers every custom question in the layout, labeled by its own label", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "custom_question", key: "second_department", label: "Second department?", type: "SINGLE_SELECT", required: true },
      ],
    };
    expect(buildFieldOptions(layout)).toContainEqual({ value: "second_department", label: "Second department?" });
  });

  // Finding 2 (MEDIUM): staffTitle and epicIdExpiration in the shipped
  // defaults gate on yaleAffiliation/hasEpic, both non-core system fields.
  // Those must be offered as controllers, keyed by the name the field
  // actually uses in the onboarding answers map (its form input name), not
  // its systemKey -- dob's answer-map key is dateOfBirth, not "dob".
  it("offers a non-core system field by its answer-map key, not its systemKey", () => {
    const layout: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "dob" }] };
    expect(buildFieldOptions(layout)).toContainEqual({ value: "dateOfBirth", label: "Date of birth" });
  });

  it("labels a non-core system field controller with its overridden label when set", () => {
    const layout: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "yaleAffiliation", label: "Affiliation with Yale" }] };
    expect(buildFieldOptions(layout)).toContainEqual({ value: "yaleAffiliation", label: "Affiliation with Yale" });
  });

  it("offers every non-core system field the shipped defaults actually gate on", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "yaleAffiliation" },
        { kind: "system_field", systemKey: "epic" },
      ],
    };
    const values = buildFieldOptions(layout).map((o) => o.value);
    expect(values).toEqual(["department", "track", "epicRequirement", "yaleAffiliation", "hasEpic"]);
  });

  it("never offers a CORE system field (name/email/epic/hipaa) by its own key", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "name" },
        { kind: "system_field", systemKey: "email" },
        { kind: "system_field", systemKey: "epic" },
        { kind: "system_field", systemKey: "hipaa" },
      ],
    };
    const values = buildFieldOptions(layout).map((o) => o.value);
    expect(values).not.toContain("name");
    expect(values).not.toContain("email");
    expect(values).not.toContain("epic");
    expect(values).not.toContain("hipaa");
  });

  it("offers the special hasEpic controller only when the layout includes the epic block", () => {
    const withEpic: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "epic" }] };
    const withoutEpic: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "netId" }] };
    expect(buildFieldOptions(withEpic).map((o) => o.value)).toContain("hasEpic");
    expect(buildFieldOptions(withoutEpic).map((o) => o.value)).not.toContain("hasEpic");
  });

  it("labels the hasEpic controller readably", () => {
    const layout: ContractLayout = { blocks: [{ kind: "system_field", systemKey: "epic" }] };
    expect(buildFieldOptions(layout)).toContainEqual({ value: "hasEpic", label: "Has Epic ID" });
  });

  // spanish/licensedRN checkboxes and initials render without ever calling
  // onAnswer (see contract-field.tsx), so their value never lands in the
  // onboarding answers map on either client or server. Offering them as
  // controllers would recreate the exact bug this fix addresses: a "When"
  // dropdown value with no way for the condition to ever actually resolve.
  it("does not offer system fields that never report a value into the answers map", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "system_field", systemKey: "spanish" },
        { kind: "system_field", systemKey: "licensedRN" },
        { kind: "system_field", systemKey: "initials" },
      ],
    };
    const values = buildFieldOptions(layout).map((o) => o.value);
    expect(values).toEqual(["department", "track", "epicRequirement"]);
  });

  it("does not offer a system field controller for a field absent from the layout", () => {
    const layout: ContractLayout = { blocks: [] };
    const values = buildFieldOptions(layout).map((o) => o.value);
    expect(values).not.toContain("staffTitle");
    expect(values).not.toContain("hasEpic");
  });
});
