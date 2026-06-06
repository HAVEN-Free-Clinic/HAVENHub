import { describe, expect, it } from "vitest";
import type { Person } from "@prisma/client";
import { ALL_PEOPLE_FIELDS } from "./fields";
import { personMirrorPayload } from "./mirror-map";

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
});
