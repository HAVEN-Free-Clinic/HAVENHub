import { describe, expect, it } from "vitest";
import type { Person } from "@prisma/client";
import { ALL_PEOPLE_FIELDS } from "./fields";
import { personMirrorPayload, parseFieldMap, type PersonFieldMap } from "./mirror-map";

/** Minimal Person-shaped object with all mirrored fields set to null. */
function nullPerson(): Person {
  return {
    id: "cuid-test-1",
    netId: null,
    entraObjectId: null,
    name: "Test Person",
    contactEmail: null,
    yaleEmail: null,
    phone: null,
    epicId: null,
    yaleAffiliation: null,
    gradYear: null,
    status: "ACTIVE",
    airtableRecordId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("personMirrorPayload", () => {
  it("payload keys are exactly the seven ALL_PEOPLE_FIELDS ids", () => {
    const person = nullPerson();
    const payload = personMirrorPayload(person);
    const actualKeys = Object.keys(payload).sort();
    const expectedKeys = Object.values(ALL_PEOPLE_FIELDS).sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it("null DB values become empty strings", () => {
    const person = nullPerson();
    // name is the only required field; set the rest to null
    const payload = personMirrorPayload(person);
    // All optional fields (netId, contactEmail, phone, epicId, yaleAffiliation, gradYear) are null
    // They must map to "" not null/undefined
    for (const [key, value] of Object.entries(payload)) {
      if (key !== ALL_PEOPLE_FIELDS.name) {
        expect(value, `field ${key} should be "" not ${JSON.stringify(value)}`).toBe("");
      }
    }
  });

  it("uses a custom fieldMap when provided: payload keys come from the map", () => {
    const sandboxMap: PersonFieldMap = {
      name: "fldnyPNurTfUTCI3M",
      netId: "fldzDXBuegWh43qBe",
      contactEmail: "flddaZKIRSx3xoss3",
      phone: "fldKV9uyerHHBr9VB",
      epicId: "fldYAk27EVKbK9GZn",
      yaleAffiliation: "fldcqbmdOvL1ZwXgH",
      gradYear: "fldVjHtbPzhGXeH75",
    };
    const person = { ...nullPerson(), name: "Alice", netId: "ak001" };
    const payload = personMirrorPayload(person, sandboxMap);
    // Keys must be the sandbox field ids, not the production ones
    expect(Object.keys(payload).sort()).toEqual(Object.values(sandboxMap).sort());
    expect(payload[sandboxMap.name]).toBe("Alice");
    expect(payload[sandboxMap.netId]).toBe("ak001");
    // Production field ids must not appear
    for (const prodId of Object.values(ALL_PEOPLE_FIELDS)) {
      expect(payload).not.toHaveProperty(prodId);
    }
  });
});

describe("parseFieldMap", () => {
  it("returns ALL_PEOPLE_FIELDS when undefined is passed", () => {
    const result = parseFieldMap(undefined);
    expect(result).toEqual(ALL_PEOPLE_FIELDS);
  });

  it("returns ALL_PEOPLE_FIELDS when empty string is passed", () => {
    expect(parseFieldMap("")).toEqual(ALL_PEOPLE_FIELDS);
  });

  it("returns ALL_PEOPLE_FIELDS when whitespace-only string is passed", () => {
    expect(parseFieldMap("   ")).toEqual(ALL_PEOPLE_FIELDS);
  });

  it("parses a valid JSON string to a PersonFieldMap", () => {
    const map: PersonFieldMap = {
      name: "fldnyPNurTfUTCI3M",
      netId: "fldzDXBuegWh43qBe",
      contactEmail: "flddaZKIRSx3xoss3",
      phone: "fldKV9uyerHHBr9VB",
      epicId: "fldYAk27EVKbK9GZn",
      yaleAffiliation: "fldcqbmdOvL1ZwXgH",
      gradYear: "fldVjHtbPzhGXeH75",
    };
    const result = parseFieldMap(JSON.stringify(map));
    expect(result).toEqual(map);
  });

  it("throws a descriptive error for invalid JSON", () => {
    expect(() => parseFieldMap("not-json")).toThrow(/AIRTABLE_MIRROR_FIELD_MAP/);
  });

  it("throws when the parsed object is missing a required key", () => {
    const bad = { name: "fldA", netId: "fldB" }; // missing 5 keys
    expect(() => parseFieldMap(JSON.stringify(bad))).toThrow(/AIRTABLE_MIRROR_FIELD_MAP/);
  });
});
