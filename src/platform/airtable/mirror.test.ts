import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { ALL_PEOPLE_FIELDS, ALL_PEOPLE_FIELDS as PROD_FIELDS } from "./fields";
import { drainOutbox, type MirrorIo, type MirrorTarget } from "./mirror";
import { parseFieldMap } from "./mirror-map";

const BASE_ID = "appTestBase1234567";
const TABLE_ID = "tblTestTable123456";

/** Fake io that succeeds by default (writer + listAll returning empty). */
function fakeIo(listAllImpl?: MirrorIo["listAll"]): MirrorIo {
  return {
    patchRecord: vi.fn().mockResolvedValue({}),
    createRecord: vi.fn().mockResolvedValue({ id: "recNew" }),
    listAll: vi.fn(listAllImpl ?? (async () => [])),
  };
}

/** Keep backward compat for tests that only used AirtableWriter shape. */
function fakeWriter(): MirrorIo {
  return fakeIo();
}

const enabledTarget: MirrorTarget = {
  enabled: true,
  baseId: BASE_ID,
  peopleTableId: TABLE_ID,
  fieldMap: parseFieldMap(undefined),
};

const disabledTarget: MirrorTarget = {
  enabled: false,
  baseId: BASE_ID,
  peopleTableId: TABLE_ID,
  fieldMap: parseFieldMap(undefined),
};

/** Create a person and return it. */
async function createPerson(overrides: { name?: string } = {}) {
  return prisma.person.create({
    data: { name: overrides.name ?? "Jane Doe" },
  });
}

/** Create a PENDING outbox row for a person. */
async function createOutboxRow(personId: string) {
  return prisma.outbox.create({
    data: {
      entityType: "Person",
      entityId: personId,
      operation: "upsert",
      changedFields: ["name"],
      status: "PENDING",
    },
  });
}

/** Create a MirrorRecord mapping for a person. */
async function createMapping(personId: string, recordId = "recExisting") {
  return prisma.mirrorRecord.create({
    data: {
      entityType: "Person",
      entityId: personId,
      baseId: BASE_ID,
      recordId,
    },
  });
}

describe("drainOutbox", () => {
  beforeEach(resetDb);

  it("patches an existing mapping and marks the row SENT with processedAt set", async () => {
    const person = await createPerson();
    await createMapping(person.id, "recExisting");
    const row = await createOutboxRow(person.id);
    const writer = fakeWriter();

    const result = await drainOutbox(writer, enabledTarget);

    expect(result).toBe(1);
    expect(writer.patchRecord).toHaveBeenCalledOnce();
    expect(writer.patchRecord).toHaveBeenCalledWith(
      BASE_ID,
      TABLE_ID,
      "recExisting",
      expect.objectContaining({ [ALL_PEOPLE_FIELDS.name]: expect.any(String) })
    );
    expect(writer.createRecord).not.toHaveBeenCalled();

    const updatedRow = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("SENT");
    expect(updatedRow.processedAt).not.toBeNull();
  });

  it("creates a record when no mapping exists and stores the MirrorRecord", async () => {
    const person = await createPerson();
    const row = await createOutboxRow(person.id);
    const writer = fakeWriter();

    const result = await drainOutbox(writer, enabledTarget);

    expect(result).toBe(1);
    expect(writer.createRecord).toHaveBeenCalledOnce();
    expect(writer.patchRecord).not.toHaveBeenCalled();

    const mapping = await prisma.mirrorRecord.findUnique({
      where: {
        entityType_entityId_baseId: {
          entityType: "Person",
          entityId: person.id,
          baseId: BASE_ID,
        },
      },
    });
    expect(mapping).not.toBeNull();
    expect(mapping!.recordId).toBe("recNew");

    const updatedRow = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("SENT");
  });

  it("increments attempts and stores lastError on writer failure; flips to FAILED after MAX_ATTEMPTS; processedAt null while PENDING, set on FAILED", async () => {
    const MAX_ATTEMPTS = 8;
    const person = await createPerson();

    const throwingIo: MirrorIo = {
      patchRecord: vi.fn().mockRejectedValue(new Error("network error")),
      createRecord: vi.fn().mockRejectedValue(new Error("network error")),
      listAll: vi.fn().mockResolvedValue([]),
    };

    // First call: attempts should become 1, status still PENDING, processedAt null
    await createOutboxRow(person.id);
    await drainOutbox(throwingIo, enabledTarget);

    let row = await prisma.outbox.findFirstOrThrow({ where: { entityId: person.id } });
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("network error");
    expect(row.status).toBe("PENDING");
    expect(row.processedAt).toBeNull();

    // Drain 7 more times (total 8 attempts) to flip to FAILED
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await drainOutbox(throwingIo, enabledTarget);
    }

    row = await prisma.outbox.findFirstOrThrow({ where: { entityId: person.id } });
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.status).toBe("FAILED");
    // processedAt must be set when flipping to FAILED
    expect(row.processedAt).not.toBeNull();
  });

  it("marks the row FAILED with 'entity no longer exists' when the person was deleted", async () => {
    const person = await createPerson();
    const row = await createOutboxRow(person.id);

    // Delete the person before draining
    await prisma.person.delete({ where: { id: person.id } });

    const writer = fakeWriter();
    await drainOutbox(writer, enabledTarget);

    const updatedRow = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("FAILED");
    expect(updatedRow.lastError).toContain("entity no longer exists");
    expect(writer.patchRecord).not.toHaveBeenCalled();
    expect(writer.createRecord).not.toHaveBeenCalled();
  });

  it("returns 0 and never calls the writer when target.enabled is false", async () => {
    const person = await createPerson();
    await createOutboxRow(person.id);
    const writer = fakeWriter();

    const result = await drainOutbox(writer, disabledTarget);

    expect(result).toBe(0);
    expect(writer.patchRecord).not.toHaveBeenCalled();
    expect(writer.createRecord).not.toHaveBeenCalled();

    const rows = await prisma.outbox.findMany({ where: { entityId: person.id } });
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
  });

  // --- adopt-or-create guard ---

  it("adopt-or-create: unmapped person with matching netId in target: listAll called, patchRecord called, createRecord NOT called, mapping stored with found id", async () => {
    const person = await prisma.person.create({
      data: { name: "Bob Adopt", netId: "ba001" },
    });
    await createOutboxRow(person.id);

    // listAll returns an existing record with the same netId (by field NAME, since names are identical across targets)
    const io = fakeIo(async () => [
      {
        id: "recAdoptMe",
        fields: {
          // Use field NAME conventions matching what the formula search returns
          // (by field id since listAll returns field ids)
          [PROD_FIELDS.netId]: "ba001",
          [PROD_FIELDS.name]: "Bob Adopt",
        },
      },
    ]);

    const result = await drainOutbox(io, enabledTarget);

    expect(result).toBe(1);
    // listAll must have been called with a formula containing the netid
    expect(io.listAll).toHaveBeenCalledOnce();
    const listAllCall = (io.listAll as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(listAllCall[2]?.filterByFormula).toContain("ba001");

    expect(io.patchRecord).toHaveBeenCalledOnce();
    expect(io.createRecord).not.toHaveBeenCalled();

    const mapping = await prisma.mirrorRecord.findUnique({
      where: {
        entityType_entityId_baseId: {
          entityType: "Person",
          entityId: person.id,
          baseId: BASE_ID,
        },
      },
    });
    expect(mapping).not.toBeNull();
    expect(mapping!.recordId).toBe("recAdoptMe");
  });

  it("adopt-or-create: when listAll returns multiple records, patches the first and emits a console.warn", async () => {
    const person = await prisma.person.create({
      data: { name: "Dup Adopt", netId: "da999" },
    });
    await createOutboxRow(person.id);

    const io = fakeIo(async () => [
      { id: "recFirst", fields: {} },
      { id: "recSecond", fields: {} },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await drainOutbox(io, enabledTarget);

    expect(result).toBe(1);
    expect(io.patchRecord).toHaveBeenCalledOnce();
    const patchedId = (io.patchRecord as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(patchedId).toBe("recFirst");
    expect(io.createRecord).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/2.*target records match person/i);

    warnSpy.mockRestore();
  });

  it("adopt-or-create: unmapped person with no match in target: createRecord called (standard path)", async () => {
    const person = await prisma.person.create({
      data: { name: "Carol Create", netId: "cc002" },
    });
    await createOutboxRow(person.id);

    // listAll returns nothing (no existing record)
    const io = fakeIo(async () => []);

    const result = await drainOutbox(io, enabledTarget);

    expect(result).toBe(1);
    expect(io.createRecord).toHaveBeenCalledOnce();
    expect(io.patchRecord).not.toHaveBeenCalled();
  });

  it("adopt-or-create: unmapped person with neither netId nor email: createRecord called, listAll NOT called", async () => {
    const person = await prisma.person.create({
      data: { name: "No Identifiers" },
    });
    await createOutboxRow(person.id);

    const io = fakeIo();

    const result = await drainOutbox(io, enabledTarget);

    expect(result).toBe(1);
    expect(io.listAll).not.toHaveBeenCalled();
    expect(io.createRecord).toHaveBeenCalledOnce();
    expect(io.patchRecord).not.toHaveBeenCalled();
  });

  it("uses custom fieldMap keys in the payload sent to patchRecord", async () => {
    const sandboxMap = {
      name: "fldnyPNurTfUTCI3M",
      netId: "fldzDXBuegWh43qBe",
      contactEmail: "flddaZKIRSx3xoss3",
      phone: "fldKV9uyerHHBr9VB",
      epicId: "fldYAk27EVKbK9GZn",
      yaleAffiliation: "fldcqbmdOvL1ZwXgH",
      gradYear: "fldVjHtbPzhGXeH75",
    };
    const sandboxTarget: MirrorTarget = {
      enabled: true,
      baseId: BASE_ID,
      peopleTableId: TABLE_ID,
      fieldMap: sandboxMap,
    };

    const person = await createPerson({ name: "Sandbox Person" });
    await createMapping(person.id, "recSandbox1");
    await createOutboxRow(person.id);

    const io = fakeWriter();
    await drainOutbox(io, sandboxTarget);

    expect(io.patchRecord).toHaveBeenCalledOnce();
    const calledFields = (io.patchRecord as ReturnType<typeof vi.fn>).mock.calls[0][3] as Record<string, unknown>;
    // Payload keys must be sandbox field ids
    expect(calledFields).toHaveProperty(sandboxMap.name);
    // Production field ids must NOT appear
    for (const prodId of Object.values(PROD_FIELDS)) {
      expect(calledFields).not.toHaveProperty(prodId);
    }
  });
});
