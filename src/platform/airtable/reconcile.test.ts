import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { ALL_PEOPLE_FIELDS } from "./fields";
import { personMirrorPayload, parseFieldMap } from "./mirror-map";
import { reconcilePeople, type AirtableReader } from "./reconcile";
import type { AirtableWriter, MirrorTarget } from "./mirror";

const BASE_ID = "appTestBase1234567";
const TABLE_ID = "tblTestTable123456";

const enabledTarget: MirrorTarget = {
  enabled: true,
  baseId: BASE_ID,
  peopleTableId: TABLE_ID,
  fieldMap: parseFieldMap(undefined),
  hipaaFieldId: null,
};

const disabledTarget: MirrorTarget = {
  enabled: false,
  baseId: BASE_ID,
  peopleTableId: TABLE_ID,
  fieldMap: parseFieldMap(undefined),
  hipaaFieldId: null,
};

/** Create a fake io object with vi.fn() for listAll, patchRecord, createRecord. */
function fakeIo(
  listAllImpl: AirtableReader["listAll"] = async () => []
): AirtableReader & AirtableWriter {
  return {
    listAll: vi.fn(listAllImpl),
    patchRecord: vi.fn().mockResolvedValue({}),
    createRecord: vi.fn().mockResolvedValue({ id: "recNew" }),
  };
}

/** Create a person in the DB and a MirrorRecord mapping for it. */
async function createPersonWithMapping(
  overrides: {
    name?: string;
    netId?: string;
    contactEmail?: string;
    phone?: string;
    epicId?: string;
    yaleAffiliation?: string;
    gradYear?: string;
  } = {},
  recordId = "recAirtable1"
) {
  const person = await prisma.person.create({
    data: {
      name: overrides.name ?? "Jane Doe",
      netId: overrides.netId ?? null,
      contactEmail: overrides.contactEmail ?? null,
      phone: overrides.phone ?? null,
      epicId: overrides.epicId ?? null,
      yaleAffiliation: overrides.yaleAffiliation ?? null,
      gradYear: overrides.gradYear ?? null,
    },
  });
  await prisma.mirrorRecord.create({
    data: {
      entityType: "Person",
      entityId: person.id,
      baseId: BASE_ID,
      recordId,
    },
  });
  return { person, recordId };
}

describe("reconcilePeople", () => {
  beforeEach(resetDb);

  it("detects and corrects one drifted field, audits the drift, returns 1", async () => {
    const { person, recordId } = await createPersonWithMapping(
      { name: "Jane Doe", netId: "jd123" },
      "recJane1"
    );

    // Build the payload that matches the DB state (the "correct" values)
    const correctPayload = personMirrorPayload(person);

    // Airtable has a DIFFERENT value for the name field only
    const driftedAirtableFields: Record<string, unknown> = {
      ...correctPayload,
      [ALL_PEOPLE_FIELDS.name]: "Jane Doe (WRONG)", // drifted
    };

    const io = fakeIo(async (_baseId, _tableId) => [
      { id: recordId, fields: driftedAirtableFields },
    ]);

    const result = await reconcilePeople(io, enabledTarget);

    expect(result).toBe(1);

    // patchRecord called once, with ONLY the drifted field (name)
    expect(io.patchRecord).toHaveBeenCalledOnce();
    const [calledBase, calledTable, calledRecordId, calledFields] = (
      io.patchRecord as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, string, string, Record<string, unknown>];
    expect(calledBase).toBe(BASE_ID);
    expect(calledTable).toBe(TABLE_ID);
    expect(calledRecordId).toBe(recordId);
    // Only the name field should be in the patch
    expect(Object.keys(calledFields)).toEqual([ALL_PEOPLE_FIELDS.name]);
    expect(calledFields[ALL_PEOPLE_FIELDS.name]).toBe("Jane Doe");

    // AuditLog row with action "mirror.drift_corrected" must exist
    const auditRows = await prisma.auditLog.findMany({
      where: { action: "mirror.drift_corrected", entityId: person.id },
    });
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0];
    expect(audit.entityType).toBe("Person");
    // before contains the drifted field value
    expect((audit.before as Record<string, unknown>)[ALL_PEOPLE_FIELDS.name]).toBe(
      "Jane Doe (WRONG)"
    );
    // after contains the corrected value
    expect((audit.after as Record<string, unknown>)[ALL_PEOPLE_FIELDS.name]).toBe("Jane Doe");
  });

  it("no-ops when Airtable matches Postgres exactly: patchRecord never called, returns 0, no audit rows", async () => {
    const { person, recordId } = await createPersonWithMapping(
      { name: "John Smith", netId: "js456", contactEmail: "john.smith@yale.edu" },
      "recJohn1"
    );

    const correctPayload = personMirrorPayload(person);

    // Airtable returns exactly what the DB has
    const io = fakeIo(async () => [{ id: recordId, fields: correctPayload }]);

    const result = await reconcilePeople(io, enabledTarget);

    expect(result).toBe(0);
    expect(io.patchRecord).not.toHaveBeenCalled();

    const auditRows = await prisma.auditLog.findMany({
      where: { action: "mirror.drift_corrected" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("skips unmapped/missing records without patching or throwing, returns 0", async () => {
    // Case A: a MirrorRecord pointing at a recordId NOT in listAll results
    const { person: _personA } = await createPersonWithMapping(
      { name: "Missing In Airtable" },
      "recNotInListAll"
    );

    // Case B: a person that was deleted (mapping points to an entity that no longer exists)
    // We create a mapping with a non-existent entityId directly
    await prisma.mirrorRecord.create({
      data: {
        entityType: "Person",
        entityId: "cuid-deleted-person-xyz",
        baseId: BASE_ID,
        recordId: "recDeletedPerson",
      },
    });

    // listAll returns records for both: recNotInListAll is absent, recDeletedPerson has data
    // but its person is missing from the DB
    const io = fakeIo(async () => [
      { id: "recDeletedPerson", fields: { [ALL_PEOPLE_FIELDS.name]: "Ghost" } },
      // recNotInListAll is NOT returned -- it's absent from Airtable
    ]);

    const result = await reconcilePeople(io, enabledTarget);

    expect(result).toBe(0);
    expect(io.patchRecord).not.toHaveBeenCalled();
    expect(io.createRecord).not.toHaveBeenCalled();

    // The valid person (personA) was not patched because their recordId was missing from listAll
    // No audit logs written
    const auditRows = await prisma.auditLog.findMany({
      where: { action: "mirror.drift_corrected" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("returns 0 and never calls listAll when the target is disabled", async () => {
    await createPersonWithMapping({ name: "Disabled Target Person" }, "recDisabled1");

    const io = fakeIo(async () => []);

    const result = await reconcilePeople(io, disabledTarget);

    expect(result).toBe(0);
    expect(io.listAll).not.toHaveBeenCalled();
  });
});
