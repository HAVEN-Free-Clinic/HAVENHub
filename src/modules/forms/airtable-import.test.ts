import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { AirtableClient, type AirtableRecord, type AirtableTableSchema } from "@/platform/airtable/client";
import { importAirtableTable, parseAirtableRef, planFields, AirtableImportError } from "./airtable-import";
import { listResponses } from "./service";

beforeEach(resetDb);

const BASE = "appkxTQ19GmaHgW1O";
const TABLE = "tblCEu8nG1t4M0Wu6";
const PEOPLE = "tblnHgBpknuqWvx9c";

const SCHEMA: AirtableTableSchema[] = [
  {
    id: TABLE,
    name: "Mid-Semester Feedback SU26",
    primaryFieldId: "fldId",
    fields: [
      { id: "fldId", name: "Id", type: "autoNumber" },
      { id: "fldWho", name: "Select Your Name", type: "multipleRecordLinks", options: { linkedTableId: PEOPLE } },
      { id: "fldDept", name: "Department", type: "multipleLookupValues" },
      { id: "fldSat", name: "How satisfied are you overall?", type: "rating", options: { max: 5 } },
      {
        id: "fldOften",
        name: "How often do you feel informed?",
        type: "singleSelect",
        options: { choices: [{ id: "s1", name: "Always" }, { id: "s2", name: "Often" }] },
      },
      {
        id: "fldVia",
        name: "How do you receive updates?",
        type: "multipleSelects",
        options: { choices: [{ id: "m1", name: "Emails" }, { id: "m2", name: "Microsoft Teams" }] },
      },
      { id: "fldWell", name: "What is one thing your department does well?", type: "multilineText" },
      { id: "fldWhen", name: "Completion Date", type: "createdTime" },
    ],
  },
  {
    id: PEOPLE,
    name: "All People",
    primaryFieldId: "fldName",
    fields: [{ id: "fldName", name: "Name", type: "singleLineText" }],
  },
];

function client(records: AirtableRecord[], people: AirtableRecord[] = []): AirtableClient {
  const fetchImpl = (async (url: string) => {
    const body = url.includes("/meta/bases/")
      ? { tables: SCHEMA }
      : url.includes(PEOPLE)
        ? { records: people }
        : { records };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
}

const row = (id: string, who: string, fields: Record<string, unknown>, when: string): AirtableRecord => ({
  id,
  createdTime: when,
  fields: { fldWho: [who], fldWhen: when, ...fields },
});

describe("parseAirtableRef", () => {
  it("reads ids out of a pasted Airtable link", () => {
    expect(parseAirtableRef(`https://airtable.com/${BASE}/${TABLE}?blocks=hide`)).toEqual({ baseId: BASE, tableId: TABLE });
    expect(parseAirtableRef("not a link")).toBeNull();
  });
});

describe("planFields", () => {
  it("turns answer fields into questions and skips derived ones", () => {
    const plans = planFields(SCHEMA[0]);
    expect(plans.map((p) => (p.kind === "question" ? p.question.type : p.kind))).toEqual([
      "respondent",
      "rating",
      "single_choice",
      "multi_choice",
      "long_text",
      "submittedAt",
    ]);
  });
});

describe("importAirtableTable", () => {
  it("builds a closed form, matches people by airtableRecordId, and keeps unmatched rows by name", async () => {
    const staff = await prisma.person.create({ data: { name: "Staff" } });
    const meera = await prisma.person.create({ data: { name: "Meera Nair", airtableRecordId: "recMeera0000000001" } });
    const records = [
      row("recA00000000000001", "recMeera0000000001", { fldSat: 5, fldOften: "Often", fldVia: ["Emails", "Microsoft Teams"], fldWell: "Culture" }, "2026-06-29T18:54:36.000Z"),
      row("recB00000000000002", "recGhost0000000002", { fldSat: 4, fldOften: "Sometimes" }, "2026-06-29T12:45:41.000Z"),
    ];
    const result = await importAirtableTable(
      staff.id,
      { pat: "pat", baseId: BASE, tableId: TABLE },
      client(records, [{ id: "recGhost0000000002", fields: { fldName: "Margarita Blackwood" } }]),
    );
    expect(result).toMatchObject({ imported: 2, matched: 1, unmatched: 1 });

    const form = await prisma.form.findUniqueOrThrow({ where: { id: result.formId } });
    expect(form).toMatchObject({ title: "Mid-Semester Feedback SU26", status: "CLOSED" });
    // "Sometimes" was not one of the table's choices but appears in a row: kept.
    const often = (form.layout as { questions: Array<{ label: string; options?: string[] }> }).questions.find((q) =>
      q.label.startsWith("How often"),
    );
    expect(often?.options).toEqual(["Always", "Often", "Sometimes"]);

    const responses = await listResponses(result.formId);
    const byName = Object.fromEntries(responses.map((r) => [r.name, r]));
    expect(byName["Meera Nair"]).toMatchObject({ personId: meera.id, source: "AIRTABLE" });
    expect(Object.values(byName["Meera Nair"].answers)).toEqual(
      expect.arrayContaining(["5", "Often", ["Emails", "Microsoft Teams"], "Culture"]),
    );
    expect(byName["Margarita Blackwood"]).toMatchObject({ personId: null });
    expect(byName["Meera Nair"].submittedAt.toISOString()).toBe("2026-06-29T18:54:36.000Z");
  });

  it("is idempotent, and ties a repeat responder's LATEST row to them", async () => {
    const staff = await prisma.person.create({ data: { name: "Staff" } });
    const meera = await prisma.person.create({ data: { name: "Meera Nair", airtableRecordId: "recMeera0000000001" } });
    const records = [
      row("recA00000000000001", "recMeera0000000001", { fldSat: 2 }, "2026-06-01T00:00:00.000Z"),
      row("recB00000000000002", "recMeera0000000001", { fldSat: 5 }, "2026-06-20T00:00:00.000Z"),
    ];
    const first = await importAirtableTable(staff.id, { pat: "pat", baseId: BASE, tableId: TABLE }, client(records));
    const again = await importAirtableTable(staff.id, { pat: "pat", baseId: BASE, tableId: TABLE }, client(records));
    expect(again.formId).toBe(first.formId);
    expect(await prisma.formResponse.count()).toBe(2);
    const mine = await prisma.formResponse.findFirstOrThrow({ where: { personId: meera.id } });
    expect(Object.values(mine.answers as object)).toContain("5");
  });

  it("explains a token without schema access", async () => {
    const staff = await prisma.person.create({ data: { name: "Staff" } });
    const denied = new AirtableClient("pat", {
      fetchImpl: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch,
      retryDelayMs: 1,
    });
    await expect(importAirtableTable(staff.id, { pat: "pat", baseId: BASE, tableId: TABLE }, denied)).rejects.toThrow(
      AirtableImportError,
    );
  });
});
