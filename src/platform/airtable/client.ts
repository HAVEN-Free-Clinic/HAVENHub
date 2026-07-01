const API_ROOT = "https://api.airtable.com/v0";
const CONTENT_ROOT = "https://content.airtable.com/v0";

export type AirtableRecord = {
  id: string;
  /** Keyed by FIELD ID (returnFieldsByFieldId=true is the project convention). */
  fields: Record<string, unknown>;
};

export type AirtableClientOptions = {
  fetchImpl?: typeof fetch;
  /** Base backoff delay; doubles per attempt. Tests pass 1ms. */
  retryDelayMs?: number;
  maxRetries?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Airtable REST client. Retries 429 and 5xx with exponential backoff
 * (the API allows 5 req/s per base); never retries other 4xx. Ported from
 * HAVEN-scheduler's server/airtable.ts.
 */
export class AirtableClient {
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly pat: string,
    options: AirtableClientOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxRetries = options.maxRetries ?? 5;
  }

  private async request(url: string, init: RequestInit = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.pat}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const body = await response.text();
        throw new Error(`Airtable ${response.status} for ${url}: ${body.slice(0, 300)}`);
      }
      await sleep(this.retryDelayMs * 2 ** attempt);
    }
  }

  async listAll(
    baseId: string,
    tableId: string,
  ): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset: string | undefined;
    do {
      const params = new URLSearchParams({ returnFieldsByFieldId: "true" });
      if (offset) params.set("offset", offset);
      const data = (await this.request(
        `${API_ROOT}/${baseId}/${tableId}?${params}`
      )) as { records: AirtableRecord[]; offset?: string };
      records.push(...data.records);
      offset = data.offset;
    } while (offset);
    return records;
  }

  async patchRecord(
    baseId: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>
  ): Promise<AirtableRecord> {
    return (await this.request(`${API_ROOT}/${baseId}/${tableId}/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ fields, typecast: true }),
    })) as AirtableRecord;
  }

  async createRecord(
    baseId: string,
    tableId: string,
    fields: Record<string, unknown>
  ): Promise<AirtableRecord> {
    return (await this.request(`${API_ROOT}/${baseId}/${tableId}`, {
      method: "POST",
      body: JSON.stringify({ fields, typecast: true }),
    })) as AirtableRecord;
  }

  /**
   * Fetch a single record by ID. Uses returnFieldsByFieldId=true, consistent
   * with the project convention. Throws on 4xx/5xx; retries 429 and 5xx.
   */
  async getRecord(
    baseId: string,
    tableId: string,
    recordId: string,
  ): Promise<AirtableRecord> {
    return (await this.request(
      `${API_ROOT}/${baseId}/${tableId}/${recordId}?returnFieldsByFieldId=true`,
    )) as AirtableRecord;
  }

  /**
   * Upload an attachment to an existing record via the Airtable Content API.
   * Uses the same retry/error envelope as request() (429 and 5xx are retried).
   */
  async uploadAttachment(
    baseId: string,
    recordId: string,
    fieldId: string,
    file: { name: string; type: string; base64: string }
  ): Promise<unknown> {
    return this.request(
      `${CONTENT_ROOT}/${baseId}/${recordId}/${fieldId}/uploadAttachment`,
      {
        method: "POST",
        body: JSON.stringify({
          contentType: file.type,
          file: file.base64,
          filename: file.name,
        }),
      }
    );
  }
}
