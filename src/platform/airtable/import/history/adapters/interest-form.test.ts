import { describe, it, expect } from "vitest";
import { transformInterestForm, INTEREST_FIELDS as F } from "./interest-form";

const SOURCE = {
  code: "INTEREST", label: "Interest form", track: "VOLUNTEER" as const, termCode: null,
  baseId: "appyZMpXNJ0rVzOT8", adapter: "interest-form" as const,
  tables: { responses: "tblEacqiHtqKMJphX", responsesOld: "tbl55zvZUFQgcnp04" },
};

const record = (id: string, fields: Record<string, unknown>) => ({ id, fields });
const only = (responses: ReturnType<typeof record>[], responsesOld: ReturnType<typeof record>[] = []) => ({
  responses,
  responsesOld,
});

describe("transformInterestForm", () => {
  it("splits a two-token Name into first and last", () => {
    const [row] = transformInterestForm(only([record("rec1", {
      [F.responses.name]: "Ada Lovelace", [F.responses.email]: "ada@yale.edu",
    })]), SOURCE);
    expect(row.identity).toEqual({ firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", netId: null });
    expect(row.source).toEqual({ baseId: SOURCE.baseId, tableId: "tblEacqiHtqKMJphX", recordId: "rec1" });
  });

  it("puts a single-token Name entirely in first name, with an empty last name", () => {
    const [row] = transformInterestForm(only([record("rec1", {
      [F.responses.name]: "Cher", [F.responses.email]: "cher@yale.edu",
    })]), SOURCE);
    expect(row.identity.firstName).toBe("Cher");
    expect(row.identity.lastName).toBe("");
  });

  it("splits only on the FIRST space, keeping middle names in the last name", () => {
    const [row] = transformInterestForm(only([record("rec1", {
      [F.responses.name]: "Mary Jane Watson", [F.responses.email]: "mj@yale.edu",
    })]), SOURCE);
    expect(row.identity.firstName).toBe("Mary");
    expect(row.identity.lastName).toBe("Jane Watson");
  });

  it("reads rows from the old MS table too, using its own field ids", () => {
    const rows = transformInterestForm(only(
      [record("recNew", { [F.responses.name]: "New Row", [F.responses.email]: "new@yale.edu" })],
      [record("recOld", { [F.responsesOld.name]: "Old Row", [F.responsesOld.email]: "old@yale.edu" })],
    ), SOURCE);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source.recordId === "recOld")!.identity.email).toBe("old@yale.edu");
    expect(rows.find((r) => r.source.recordId === "recOld")!.source.tableId).toBe("tbl55zvZUFQgcnp04");
  });

  it("skips a row with no email, which is Airtable cruft", () => {
    expect(transformInterestForm(only([
      record("rec1", { [F.responses.name]: "No Email" }),
    ]), SOURCE)).toHaveLength(0);
  });
});
