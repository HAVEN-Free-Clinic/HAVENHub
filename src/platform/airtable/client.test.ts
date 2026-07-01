import { describe, expect, it, vi } from "vitest";
import { AirtableClient } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AirtableClient", () => {
  it("follows pagination offsets in listAll", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { records: [{ id: "rec1", fields: {} }], offset: "page2" })
      )
      .mockResolvedValueOnce(jsonResponse(200, { records: [{ id: "rec2", fields: {} }] }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    const records = await client.listAll("appX", "tblY");
    expect(records.map((r) => r.id)).toEqual(["rec1", "rec2"]);
    expect(fetchImpl.mock.calls[1][0]).toContain("offset=page2");
    // Field-id keyed responses are the project convention (rename-proof).
    expect(fetchImpl.mock.calls[0][0]).toContain("returnFieldsByFieldId=true");
  });

  it("retries 429 with backoff and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate" }))
      .mockResolvedValueOnce(jsonResponse(200, { records: [] }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    await expect(client.listAll("appX", "tblY")).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on 5xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1, maxRetries: 2 });
    await expect(client.listAll("appX", "tblY")).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry 4xx other than 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(422, { error: "bad field" }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    await expect(
      client.patchRecord("appX", "tblY", "recZ", { fldA: "v" })
    ).rejects.toThrow(/422/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends typecast PATCH bodies keyed by field id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "recZ", fields: {} }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    await client.patchRecord("appX", "tblY", "recZ", { fldA: "v" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/appX/tblY/recZ");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ fields: { fldA: "v" }, typecast: true });
  });

  it("creates records and returns the new id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "recNew", fields: {} }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    const created = await client.createRecord("appX", "tblY", { fldA: "v" });
    expect(created.id).toBe("recNew");
  });

  it("uploadAttachment: POSTs to the content API URL with correct body shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "recNew", fields: {} }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    await client.uploadAttachment("appX", "recZ", "fldA", {
      name: "cert.pdf",
      type: "application/pdf",
      base64: "AAAA",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://content.airtable.com/v0/appX/recZ/fldA/uploadAttachment");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      contentType: "application/pdf",
      file: "AAAA",
      filename: "cert.pdf",
    });
  });

  it("getRecord: fetches a single record by id with returnFieldsByFieldId=true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "recZ", fields: { fldA: "v" } })
    );
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    const record = await client.getRecord("appX", "tblY", "recZ");
    expect(record.id).toBe("recZ");
    expect(record.fields.fldA).toBe("v");
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/appX/tblY/recZ");
    expect(url).toContain("returnFieldsByFieldId=true");
  });

  it("getRecord: retries 429 and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "recZ", fields: {} }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    await expect(client.getRecord("appX", "tblY", "recZ")).resolves.toMatchObject({ id: "recZ" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uploadAttachment: retries 429 and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "recZ", fields: {} }));
    const client = new AirtableClient("pat", { fetchImpl, retryDelayMs: 1 });
    await expect(
      client.uploadAttachment("appX", "recZ", "fldA", {
        name: "cert.pdf",
        type: "application/pdf",
        base64: "AAAA",
      })
    ).resolves.not.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
