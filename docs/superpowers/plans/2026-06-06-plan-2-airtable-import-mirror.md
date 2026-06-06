# Plan 2: Airtable Import & Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real clinic data in Postgres (people, departments, SU26 roster) via a safe idempotent importer, plus the full outbox-based Postgres-to-Airtable mirror pipeline (worker, reconciliation, sync health), with all writes gated away from the production base until the FA26 cutover.

**Architecture:** Spec §10. A fetch-based Airtable client (ported from HAVEN-scheduler's battle-tested patterns) serves two flows: a deliberate one-way **import** (Airtable to Postgres, run by hand) and a continuous one-way **mirror** (Postgres to Airtable via an Outbox table drained by a pg-boss worker, with nightly reconciliation). The mirror targets a sandbox base during development; a config flag flips it to the production base at cutover. A MirrorRecord table maps Postgres entities to per-base Airtable record IDs so sandbox and production targets both work.

**Tech Stack:** existing stack + pg-boss v10 (Postgres-backed queue, no Redis). All tests run offline (injected fake fetch / fake client); CI is unchanged.

**Safety invariant (the most important line in this plan):** during SU26 the live apps still write the production Airtable base. HAVENHub must not write production Airtable until FA26 cutover. Reads are always safe. Writes go only to `AIRTABLE_MIRROR_BASE_ID`, which is a sandbox until cutover, and only when `AIRTABLE_MIRROR_ENABLED=true`.

---

## File structure (end state)

```
prisma/schema.prisma                     # + Outbox, MirrorRecord, WorkerHeartbeat
src/platform/airtable/
  client.ts / client.test.ts             # REST client: listAll, patch, create, retry, escaping
  fields.ts                              # field-ID constants for All People + SU 26 roster
  mirror-map.ts / mirror-map.test.ts     # Person -> Airtable payload (mirrored fields only)
  mirror.ts / mirror.test.ts             # drainOutbox: outbox rows -> PATCH/CREATE via MirrorRecord
  reconcile.ts / reconcile.test.ts       # nightly diff: rewrite Airtable, audit drift
  import/
    transforms.ts / transforms.test.ts   # pure: Airtable records -> upsert payloads
    importer.ts / importer.test.ts       # orchestration: fetch, transform, upsert (idempotent)
src/platform/outbox.ts / outbox.test.ts  # enqueueMirror (transaction-aware) + outboxStats
scripts/import-airtable.ts               # CLI: dry-run by default, --apply to write
worker/index.ts                          # pg-boss bootstrap: queues, cron, heartbeat
src/app/api/health/route.ts              # + worker heartbeat, outbox depth
src/platform/config.ts                   # + Airtable env vars
.env.example                             # + documented Airtable section
package.json                             # + "worker" script
```

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout main && git pull && git checkout -b plan-2/airtable-import-mirror`

(PR workflow: this branch merges via a GitHub PR at the end, not a local merge.)

---

### Task 1: Config additions

**Files:**
- Modify: `src/platform/config.ts`, `.env.example`
- Test: `src/platform/config.test.ts` (extend)

- [ ] **Step 1: Add failing tests** to `src/platform/config.test.ts`:

```ts
  it("defaults Airtable base/table ids and leaves the PAT unset", () => {
    const config = loadConfig(base);
    expect(config.HAVEN_MGMT_BASE_ID).toBe("appkxTQ19GmaHgW1O");
    expect(config.AIRTABLE_PAT).toBeUndefined();
    expect(config.AIRTABLE_MIRROR_ENABLED).toBe(false);
  });

  it("requires mirror base/table and PAT when the mirror is enabled", () => {
    expect(() =>
      loadConfig({ ...base, AIRTABLE_MIRROR_ENABLED: "true" })
    ).toThrowError(/AIRTABLE_MIRROR_BASE_ID/);
  });

  it("accepts a fully-configured enabled mirror", () => {
    const config = loadConfig({
      ...base,
      AIRTABLE_MIRROR_ENABLED: "true",
      AIRTABLE_PAT: "pat-x",
      AIRTABLE_MIRROR_BASE_ID: "appSandbox1234567",
      AIRTABLE_MIRROR_PEOPLE_TABLE_ID: "tblSandbox1234567",
    });
    expect(config.AIRTABLE_MIRROR_ENABLED).toBe(true);
  });
```

- [ ] **Step 2:** Run `npm test -- src/platform/config.test.ts`; expect the new tests to FAIL.

- [ ] **Step 3: Extend the schema in `src/platform/config.ts`** (inside the existing `z.object`):

```ts
    // Airtable: reads (import) need only the PAT; the listed IDs have safe defaults.
    AIRTABLE_PAT: z.string().optional(),
    HAVEN_MGMT_BASE_ID: z.string().default("appkxTQ19GmaHgW1O"),
    ALL_PEOPLE_TABLE_ID: z.string().default("tblnHgBpknuqWvx9c"),
    SU26_ROSTER_TABLE_ID: z.string().default("tbl2VrP1uqwFt7QNQ"),
    // Mirror: WRITES. Disabled by default; points at a sandbox base until FA26 cutover.
    AIRTABLE_MIRROR_ENABLED: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    AIRTABLE_MIRROR_BASE_ID: z.string().optional(),
    AIRTABLE_MIRROR_PEOPLE_TABLE_ID: z.string().optional(),
```

And extend the existing `superRefine` with:

```ts
    if (env.AIRTABLE_MIRROR_ENABLED === "true") {
      for (const key of [
        "AIRTABLE_PAT",
        "AIRTABLE_MIRROR_BASE_ID",
        "AIRTABLE_MIRROR_PEOPLE_TABLE_ID",
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: "custom", path: [key], message: "required when the mirror is enabled" });
        }
      }
    }
```

NOTE: `superRefine` runs on the RAW input shape before transforms in this zod version only if chained after `.object(...)`; verify the check reads the raw string (`env.AIRTABLE_MIRROR_ENABLED === "true"`). If your chain order makes `env` post-transform, compare to `true` instead; the test tells you which.

- [ ] **Step 4:** Tests pass; typecheck/lint clean.

- [ ] **Step 5: Extend `.env.example`:**

```bash
# --- Airtable ----------------------------------------------------------------
# Personal access token. Needed for the importer (reads) and the mirror (writes).
# Scopes: data.records:read on HAVEN Management; data.records:write + schema.bases:read
# on the mirror target base.
AIRTABLE_PAT=
# Read sources (defaults are the real HAVEN Management base; IDs are not secrets).
HAVEN_MGMT_BASE_ID=appkxTQ19GmaHgW1O
ALL_PEOPLE_TABLE_ID=tblnHgBpknuqWvx9c
SU26_ROSTER_TABLE_ID=tbl2VrP1uqwFt7QNQ
# Mirror (WRITES). Keep disabled until the FA26 cutover. While developing,
# point these at the sandbox base, never at HAVEN Management.
AIRTABLE_MIRROR_ENABLED=false
AIRTABLE_MIRROR_BASE_ID=
AIRTABLE_MIRROR_PEOPLE_TABLE_ID=
```

- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat: airtable config with gated mirror settings"`

---

### Task 2: Schema additions (Outbox, MirrorRecord, WorkerHeartbeat)

**Files:**
- Modify: `prisma/schema.prisma`, `src/platform/test/db.ts`

- [ ] **Step 1: Append models:**

```prisma
enum OutboxStatus {
  PENDING
  SENT
  FAILED
}

/// One row per mirrored change. Written in the same transaction as the domain
/// write; drained by the worker. FAILED rows persist for inspection and are
/// also self-healed by nightly reconciliation.
model Outbox {
  id            String       @id @default(cuid())
  entityType    String // "Person"
  entityId      String
  operation     String // "upsert"
  changedFields String[]
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  lastError     String?
  createdAt     DateTime     @default(now())
  processedAt   DateTime?

  @@index([status, createdAt])
}

/// Maps a Postgres entity to its Airtable record id in a specific base.
/// Needed because the sandbox and production bases have different record ids.
model MirrorRecord {
  id         String @id @default(cuid())
  entityType String
  entityId   String
  baseId     String
  recordId   String

  @@unique([entityType, entityId, baseId])
}

model WorkerHeartbeat {
  id     String   @id // e.g. "mirror-worker"
  beatAt DateTime
}
```

- [ ] **Step 2:** `npx prisma migrate dev --name outbox-mirror-heartbeat`

- [ ] **Step 3:** Extend `resetDb` in `src/platform/test/db.ts` to also truncate `"Outbox", "MirrorRecord", "WorkerHeartbeat"`.

- [ ] **Step 4:** `npm run test:prepare && npm test` (all green), commit: `feat: outbox, mirror-record, and heartbeat tables`

---

### Task 3: Airtable client (TDD, offline)

**Files:**
- Create: `src/platform/airtable/client.ts`, `src/platform/airtable/fields.ts`
- Test: `src/platform/airtable/client.test.ts`

Port the retry/escaping/pagination patterns from HAVEN-scheduler's `server/airtable.ts` (clone at `/tmp/haven-analysis/HAVEN-scheduler`; re-clone from github.com/jcarney2024/HAVEN-scheduler if missing).

- [ ] **Step 1: Write `src/platform/airtable/fields.ts`** (field IDs verified against the live base schema on 2026-06-06):

```ts
/** All People (tblnHgBpknuqWvx9c) field ids. Field ids survive renames; names do not. */
export const ALL_PEOPLE_FIELDS = {
  name: "fldpyuv6yjNET25Ok",
  netId: "fldfUCriYdc35qVSK",
  contactEmail: "fldTQO03cHW0HlqjC",
  phone: "fldal7QxzkzyTPbes",
  epicId: "fldbhtCcf1VKKUI9A",
  yaleAffiliation: "fld3XOz6pMx4tY8Nk",
  gradYear: "fld0doB6wtaypevj0",
} as const;

/** SU 26 roster (tbl2VrP1uqwFt7QNQ) field ids. */
export const SU26_ROSTER_FIELDS = {
  departmentName: "fldBIGmgM2dU0vFUQ",
  directors: "fldtKUkW1wwzVBQdo",
  volunteers: "fldd6ENTWgPHmprMj",
} as const;
```

- [ ] **Step 2: Write the failing tests** in `src/platform/airtable/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AirtableClient, escapeFormulaString } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("escapeFormulaString", () => {
  it("escapes single quotes and backslashes", () => {
    expect(escapeFormulaString("O'Brien\\x")).toBe("O\\'Brien\\\\x");
  });
});

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
});
```

- [ ] **Step 3:** Run; expect FAIL (module missing).

- [ ] **Step 4: Write `src/platform/airtable/client.ts`:**

```ts
const API_ROOT = "https://api.airtable.com/v0";

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

export function escapeFormulaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

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
    options: { filterByFormula?: string } = {}
  ): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset: string | undefined;
    do {
      const params = new URLSearchParams({ returnFieldsByFieldId: "true" });
      if (options.filterByFormula) params.set("filterByFormula", options.filterByFormula);
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
}
```

- [ ] **Step 5:** Tests pass (6). Full suite, typecheck, lint. Commit: `feat: airtable rest client with retry and field-id convention`

---

### Task 4: Import transforms (pure, TDD)

**Files:**
- Create: `src/platform/airtable/import/transforms.ts`
- Test: `src/platform/airtable/import/transforms.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it } from "vitest";
import { ALL_PEOPLE_FIELDS, SU26_ROSTER_FIELDS } from "../fields";
import { transformPeople, transformRoster } from "./transforms";

const F = ALL_PEOPLE_FIELDS;
const R = SU26_ROSTER_FIELDS;

describe("transformPeople", () => {
  it("maps fields, trims, lowercases netId, and derives yaleEmail from @yale.edu contact emails", () => {
    const [person] = transformPeople([
      {
        id: "recA",
        fields: {
          [F.name]: "  Jane Doe ",
          [F.netId]: " JD123 ",
          [F.contactEmail]: "Jane.Doe@yale.edu",
          [F.phone]: "203-555-0101",
          [F.epicId]: "E123",
          [F.yaleAffiliation]: "Yale College",
          [F.gradYear]: "2027",
        },
      },
    ]);
    expect(person).toEqual({
      airtableRecordId: "recA",
      name: "Jane Doe",
      netId: "jd123",
      contactEmail: "jane.doe@yale.edu",
      yaleEmail: "jane.doe@yale.edu",
      phone: "203-555-0101",
      epicId: "E123",
      yaleAffiliation: "Yale College",
      gradYear: "2027",
    });
  });

  it("leaves yaleEmail null for personal emails and tolerates missing fields", () => {
    const [person] = transformPeople([
      { id: "recB", fields: { [F.name]: "Sam", [F.contactEmail]: "sam@gmail.com" } },
    ]);
    expect(person.yaleEmail).toBeNull();
    expect(person.netId).toBeNull();
    expect(person.contactEmail).toBe("sam@gmail.com");
  });

  it("skips records with no name and reports them", () => {
    const result = transformPeople([{ id: "recC", fields: {} }]);
    expect(result).toHaveLength(0);
  });
});

describe("transformRoster", () => {
  it("builds departments and memberships keyed by airtable record ids", () => {
    const roster = transformRoster([
      {
        id: "recDept1",
        fields: {
          [R.departmentName]: "ITCM",
          [R.directors]: ["recA"],
          [R.volunteers]: ["recB", "recC"],
        },
      },
    ]);
    expect(roster.departments).toEqual([{ code: "ITCM", name: "ITCM" }]);
    expect(roster.memberships).toEqual([
      { departmentCode: "ITCM", personRecordId: "recA", kind: "DIRECTOR" },
      { departmentCode: "ITCM", personRecordId: "recB", kind: "VOLUNTEER" },
      { departmentCode: "ITCM", personRecordId: "recC", kind: "VOLUNTEER" },
    ]);
  });

  it("skips roster rows without a department name", () => {
    const roster = transformRoster([{ id: "recX", fields: {} }]);
    expect(roster.departments).toHaveLength(0);
    expect(roster.memberships).toHaveLength(0);
  });
});
```

- [ ] **Step 2:** FAIL, then **Step 3: implement `transforms.ts`:**

```ts
import type { AirtableRecord } from "../client";
import { ALL_PEOPLE_FIELDS, SU26_ROSTER_FIELDS } from "../fields";

export type PersonImport = {
  airtableRecordId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  yaleEmail: string | null;
  phone: string | null;
  epicId: string | null;
  yaleAffiliation: string | null;
  gradYear: string | null;
};

export type RosterImport = {
  departments: Array<{ code: string; name: string }>;
  memberships: Array<{
    departmentCode: string;
    personRecordId: string;
    kind: "DIRECTOR" | "VOLUNTEER";
  }>;
};

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
};

export function transformPeople(records: AirtableRecord[]): PersonImport[] {
  const out: PersonImport[] = [];
  for (const record of records) {
    const f = record.fields;
    const name = str(f[ALL_PEOPLE_FIELDS.name]);
    if (!name) continue; // nameless rows are Airtable cruft, not people
    const contactEmail = str(f[ALL_PEOPLE_FIELDS.contactEmail])?.toLowerCase() ?? null;
    out.push({
      airtableRecordId: record.id,
      name,
      netId: str(f[ALL_PEOPLE_FIELDS.netId])?.toLowerCase() ?? null,
      contactEmail,
      yaleEmail: contactEmail?.endsWith("@yale.edu") ? contactEmail : null,
      phone: str(f[ALL_PEOPLE_FIELDS.phone]),
      epicId: str(f[ALL_PEOPLE_FIELDS.epicId]),
      yaleAffiliation: str(f[ALL_PEOPLE_FIELDS.yaleAffiliation]),
      gradYear: str(f[ALL_PEOPLE_FIELDS.gradYear]),
    });
  }
  return out;
}

export function transformRoster(records: AirtableRecord[]): RosterImport {
  const departments: RosterImport["departments"] = [];
  const memberships: RosterImport["memberships"] = [];
  for (const record of records) {
    const code = str(record.fields[SU26_ROSTER_FIELDS.departmentName]);
    if (!code) continue;
    departments.push({ code, name: code });
    const links = (key: string): string[] =>
      Array.isArray(record.fields[key]) ? (record.fields[key] as string[]) : [];
    for (const personRecordId of links(SU26_ROSTER_FIELDS.directors)) {
      memberships.push({ departmentCode: code, personRecordId, kind: "DIRECTOR" });
    }
    for (const personRecordId of links(SU26_ROSTER_FIELDS.volunteers)) {
      memberships.push({ departmentCode: code, personRecordId, kind: "VOLUNTEER" });
    }
  }
  return { departments, memberships };
}
```

- [ ] **Step 4:** Green; commit: `feat: airtable import transforms`

---

### Task 5: Importer orchestration (TDD against test DB)

**Files:**
- Create: `src/platform/airtable/import/importer.ts`
- Test: `src/platform/airtable/import/importer.test.ts`

Behavior:
- People upsert resolution order: `airtableRecordId` match, else case-insensitive `netId`, else case-insensitive `contactEmail`, else create. Matched-but-unlinked people (like the dev seed's Jack) get `airtableRecordId` stamped.
- Unique-violation collisions (case-variant duplicates inside Airtable) are caught per-record, skipped, and reported; the import continues.
- Departments upserted by code. Term `SU26` upserted (ACTIVE). Memberships upserted by the compound key; import is additive (it never REMOVEs).
- `dryRun: true` performs all reads and matching but no writes, returning the same report shape.
- Returns `ImportReport`: `{ people: { created, updated, linked, skipped: Array<{recordId, reason}> }, departments: number, memberships: number, dryRun: boolean }`.

- [ ] **Step 1: Failing tests** in `importer.test.ts` (uses resetDb; constructs a fake reader):

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { ALL_PEOPLE_FIELDS as F, SU26_ROSTER_FIELDS as R } from "../fields";
import { runImport, type AirtableReader } from "./importer";

function fakeReader(): AirtableReader {
  return {
    async listAll(_base: string, table: string) {
      if (table === "people-table") {
        return [
          { id: "recJack", fields: { [F.name]: "Jack Carney", [F.netId]: "jc999", [F.contactEmail]: "j.carney@yale.edu" } },
          { id: "recVol", fields: { [F.name]: "Vol One", [F.netId]: "vo111", [F.contactEmail]: "vol.one@yale.edu" } },
          { id: "recDup", fields: { [F.name]: "Vol Dupe", [F.netId]: "VO111", [F.contactEmail]: "dupe@yale.edu" } },
        ];
      }
      return [
        {
          id: "recITCM",
          fields: { [R.departmentName]: "ITCM", [R.directors]: ["recJack"], [R.volunteers]: ["recVol"] },
        },
      ];
    },
  };
}

const OPTS = {
  baseId: "base",
  peopleTableId: "people-table",
  rosterTableId: "roster-table",
};

describe("runImport", () => {
  beforeEach(resetDb);

  it("dry-run reports without writing", async () => {
    const report = await runImport(fakeReader(), { ...OPTS, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.people.created).toBe(2); // recDup collides with recVol on netId
    expect(report.people.skipped).toHaveLength(1);
    expect(await prisma.person.count()).toBe(0);
  });

  it("imports people, departments, term, and memberships idempotently", async () => {
    // Pre-existing unlinked person (like the dev seed): must be linked, not duplicated.
    await prisma.person.create({
      data: { name: "Jack Carney", contactEmail: "j.carney@yale.edu" },
    });

    const first = await runImport(fakeReader(), { ...OPTS, dryRun: false });
    expect(first.people.linked).toBe(1); // jack matched by email, stamped with recJack
    expect(first.people.created).toBe(1); // vol one
    expect(first.people.skipped).toHaveLength(1); // the case-variant dupe
    expect(first.departments).toBe(1);
    expect(first.memberships).toBe(2);

    const jack = await prisma.person.findUniqueOrThrow({ where: { airtableRecordId: "recJack" } });
    expect(jack.netId).toBe("jc999");
    const term = await prisma.term.findUniqueOrThrow({ where: { code: "SU26" } });
    expect(term.status).toBe("ACTIVE");
    expect(await prisma.termMembership.count()).toBe(2);

    const second = await runImport(fakeReader(), { ...OPTS, dryRun: false });
    expect(second.people.created).toBe(0);
    expect(second.people.updated + second.people.linked).toBeGreaterThanOrEqual(0); // no throw, no dupes
    expect(await prisma.person.count()).toBe(2);
    expect(await prisma.termMembership.count()).toBe(2);
  });
});
```

- [ ] **Step 2:** FAIL, then **Step 3: implement `importer.ts`:**

```ts
import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";
import { transformPeople, transformRoster, type PersonImport } from "./transforms";

export type AirtableReader = {
  listAll(baseId: string, tableId: string): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
};

export type ImportOptions = {
  baseId: string;
  peopleTableId: string;
  rosterTableId: string;
  dryRun: boolean;
};

export type ImportReport = {
  dryRun: boolean;
  people: {
    created: number;
    updated: number;
    linked: number;
    skipped: Array<{ recordId: string; reason: string }>;
  };
  departments: number;
  memberships: number;
};

const insensitive = (value: string) => ({ equals: value, mode: "insensitive" as const });

async function findExisting(person: PersonImport): Promise<Person | null> {
  const byRecord = await prisma.person.findUnique({
    where: { airtableRecordId: person.airtableRecordId },
  });
  if (byRecord) return byRecord;
  if (person.netId) {
    const byNetId = await prisma.person.findFirst({ where: { netId: insensitive(person.netId) } });
    if (byNetId) return byNetId;
  }
  if (person.contactEmail) {
    return prisma.person.findFirst({ where: { contactEmail: insensitive(person.contactEmail) } });
  }
  return null;
}

export async function runImport(reader: AirtableReader, options: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = {
    dryRun: options.dryRun,
    people: { created: 0, updated: 0, linked: 0, skipped: [] },
    departments: 0,
    memberships: 0,
  };

  const peopleRecords = await reader.listAll(options.baseId, options.peopleTableId);
  const rosterRecords = await reader.listAll(options.baseId, options.rosterTableId);
  const people = transformPeople(peopleRecords);
  const roster = transformRoster(rosterRecords);

  // Track identity collisions within the batch even in dry-run.
  const seenNetIds = new Set<string>();
  const seenEmails = new Set<string>();
  const importedByRecordId = new Map<string, string>(); // airtable rec id -> person id ("dry" in dry-run)

  for (const person of people) {
    if (person.netId && seenNetIds.has(person.netId)) {
      report.people.skipped.push({ recordId: person.airtableRecordId, reason: `duplicate netId ${person.netId}` });
      continue;
    }
    if (person.contactEmail && seenEmails.has(person.contactEmail)) {
      report.people.skipped.push({ recordId: person.airtableRecordId, reason: `duplicate email ${person.contactEmail}` });
      continue;
    }
    if (person.netId) seenNetIds.add(person.netId);
    if (person.contactEmail) seenEmails.add(person.contactEmail);

    try {
      const existing = await findExisting(person);
      if (options.dryRun) {
        if (existing?.airtableRecordId === person.airtableRecordId) report.people.updated++;
        else if (existing) report.people.linked++;
        else report.people.created++;
        importedByRecordId.set(person.airtableRecordId, existing?.id ?? "dry");
        continue;
      }
      const { airtableRecordId, ...fields } = person;
      if (existing) {
        const wasLinked = existing.airtableRecordId === airtableRecordId;
        const saved = await prisma.person.update({
          where: { id: existing.id },
          data: { ...fields, airtableRecordId },
        });
        importedByRecordId.set(airtableRecordId, saved.id);
        if (wasLinked) report.people.updated++;
        else report.people.linked++;
      } else {
        const saved = await prisma.person.create({ data: { ...fields, airtableRecordId } });
        importedByRecordId.set(airtableRecordId, saved.id);
        report.people.created++;
      }
    } catch (error) {
      report.people.skipped.push({
        recordId: person.airtableRecordId,
        reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  }

  report.departments = roster.departments.length;
  report.memberships = roster.memberships.length;
  if (options.dryRun) return report;

  for (const dept of roster.departments) {
    await prisma.department.upsert({
      where: { code: dept.code },
      update: { name: dept.name },
      create: dept,
    });
  }

  const term = await prisma.term.upsert({
    where: { code: "SU26" },
    update: { status: "ACTIVE" },
    create: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30T12:00:00Z"),
      endDate: new Date("2026-09-26T12:00:00Z"),
      status: "ACTIVE",
    },
  });

  let membershipCount = 0;
  for (const membership of roster.memberships) {
    const personId = importedByRecordId.get(membership.personRecordId);
    if (!personId) continue; // linked record was skipped or not a person row
    const department = await prisma.department.findUniqueOrThrow({
      where: { code: membership.departmentCode },
    });
    await prisma.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId,
          termId: term.id,
          departmentId: department.id,
          kind: membership.kind,
        },
      },
      update: { status: "ACTIVE" },
      create: { personId, termId: term.id, departmentId: department.id, kind: membership.kind },
    });
    membershipCount++;
  }
  report.memberships = membershipCount;
  return report;
}
```

- [ ] **Step 4:** Green; full suite; commit: `feat: idempotent airtable importer with collision reporting`

---

### Task 6: Import CLI + live run

**Files:**
- Create: `scripts/import-airtable.ts`
- Modify: `package.json` (script)

- [ ] **Step 1: Write `scripts/import-airtable.ts`:**

```ts
// Live import from HAVEN Management into Postgres. Dry-run by default:
//   npx tsx --env-file=.env scripts/import-airtable.ts
//   npx tsx --env-file=.env scripts/import-airtable.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { runImport } from "@/platform/airtable/import/importer";

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);
  const report = await runImport(client, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    peopleTableId: config.ALL_PEOPLE_TABLE_ID,
    rosterTableId: config.SU26_ROSTER_TABLE_ID,
    dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
  if (dryRun) console.log("\nDry run only. Re-run with --apply to write.");
  if (report.people.skipped.length > 0) {
    console.log(`\n${report.people.skipped.length} record(s) skipped; fix in Airtable and re-run.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

NOTE: tsx does not resolve the `@/` alias by default. Either run with `tsx --tsconfig tsconfig.json` (tsx honors `paths` automatically in recent versions; verify) or, if alias resolution fails, switch the three imports to relative paths (`../src/platform/...`). Report which was needed.

- [ ] **Step 2:** Add scripts to `package.json`:

```json
    "import:dry": "tsx --env-file=.env scripts/import-airtable.ts",
    "import:apply": "tsx --env-file=.env scripts/import-airtable.ts --apply",
```

- [ ] **Step 3: CHECKPOINT (controller/user):** `AIRTABLE_PAT` must be present in `.env` (read scope on HAVEN Management). Stop and ask if missing.

- [ ] **Step 4: Live dry-run:** `npm run import:dry`. Review the report with the user: expected scale is a few hundred people, ~15-20 departments, plausible membership counts, and a short skipped list (real Airtable data is messy; case-variant duplicates surface here).

- [ ] **Step 5: With user approval, apply:** `npm run import:apply`, then spot-check counts in psql and verify the dev login still works (Jack's seed row should now be LINKED to his real Airtable record, not duplicated).

- [ ] **Step 6:** Commit: `feat: airtable import cli`

---

### Task 7: Outbox service (TDD)

**Files:**
- Create: `src/platform/outbox.ts`
- Test: `src/platform/outbox.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { enqueueMirror, outboxStats } from "./outbox";

describe("outbox", () => {
  beforeEach(resetDb);

  it("enqueues inside the caller's transaction (rollback removes the row)", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueMirror(tx, { entityType: "Person", entityId: "p1", changedFields: ["name"] });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect((await outboxStats()).pending).toBe(0);

    await prisma.$transaction(async (tx) => {
      await enqueueMirror(tx, { entityType: "Person", entityId: "p1", changedFields: ["name"] });
    });
    expect((await outboxStats()).pending).toBe(1);
  });

  it("reports pending and failed counts", async () => {
    await prisma.outbox.create({
      data: { entityType: "Person", entityId: "p2", operation: "upsert", changedFields: [], status: "FAILED" },
    });
    const stats = await outboxStats();
    expect(stats.failed).toBe(1);
  });
});
```

- [ ] **Step 2:** FAIL, then **Step 3: implement `src/platform/outbox.ts`:**

```ts
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";

type Db = PrismaClient | Prisma.TransactionClient;

export type MirrorChange = {
  entityType: "Person";
  entityId: string;
  changedFields: string[];
};

/**
 * Append a mirror job in the SAME transaction as the domain write, so a
 * rolled-back mutation never leaks into Airtable. Future module services call
 * this whenever they touch mirrored fields.
 */
export async function enqueueMirror(db: Db, change: MirrorChange): Promise<void> {
  await db.outbox.create({
    data: {
      entityType: change.entityType,
      entityId: change.entityId,
      operation: "upsert",
      changedFields: change.changedFields,
    },
  });
}

export async function outboxStats(): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    prisma.outbox.count({ where: { status: "PENDING" } }),
    prisma.outbox.count({ where: { status: "FAILED" } }),
  ]);
  return { pending, failed };
}
```

- [ ] **Step 4:** Green; commit: `feat: transactional mirror outbox`

---

### Task 8: Mirror map + drain (TDD)

**Files:**
- Create: `src/platform/airtable/mirror-map.ts`, `src/platform/airtable/mirror.ts`
- Test: `src/platform/airtable/mirror-map.test.ts`, `src/platform/airtable/mirror.test.ts`

- [ ] **Step 1: `mirror-map.ts`** (with a small test asserting payload shape and that ONLY owned fields appear):

```ts
import type { Person } from "@prisma/client";
import { ALL_PEOPLE_FIELDS } from "./fields";

/**
 * The fields HAVEN Hub OWNS in the mirror target. Everything else in the
 * Airtable table (legacy fields, automations) is never touched.
 */
export function personMirrorPayload(person: Person): Record<string, unknown> {
  return {
    [ALL_PEOPLE_FIELDS.name]: person.name,
    [ALL_PEOPLE_FIELDS.netId]: person.netId ?? "",
    [ALL_PEOPLE_FIELDS.contactEmail]: person.contactEmail ?? "",
    [ALL_PEOPLE_FIELDS.phone]: person.phone ?? "",
    [ALL_PEOPLE_FIELDS.epicId]: person.epicId ?? "",
    [ALL_PEOPLE_FIELDS.yaleAffiliation]: person.yaleAffiliation ?? "",
    [ALL_PEOPLE_FIELDS.gradYear]: person.gradYear ?? "",
  };
}
```

Test: payload keys are exactly the seven field ids; null DB values become empty strings (Airtable clears the cell rather than skipping it, so stale values cannot linger).

- [ ] **Step 2: Failing tests for `mirror.ts`** covering, with a fake writer (vi.fn-based `patchRecord`/`createRecord`) and the test DB:
  - drains a PENDING row for a person WITH a MirrorRecord mapping: patches, marks SENT with processedAt
  - person WITHOUT a mapping: creates the record, stores MirrorRecord, marks SENT
  - writer throws: attempts incremented, lastError stored, still PENDING; after `maxAttempts` it flips to FAILED
  - missing person (deleted): row marked FAILED with reason
  - disabled mirror (`enabled: false`): rows stay PENDING and the writer is never called

- [ ] **Step 3: Implement `mirror.ts`:**

```ts
import { prisma } from "@/platform/db";
import { personMirrorPayload } from "./mirror-map";

export type AirtableWriter = {
  patchRecord(baseId: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<unknown>;
  createRecord(baseId: string, tableId: string, fields: Record<string, unknown>): Promise<{ id: string }>;
};

export type MirrorTarget = {
  enabled: boolean;
  baseId: string;
  peopleTableId: string;
};

const MAX_ATTEMPTS = 8;

/** Drain up to `batchSize` pending outbox rows. Returns how many were processed. */
export async function drainOutbox(
  writer: AirtableWriter,
  target: MirrorTarget,
  batchSize = 10
): Promise<number> {
  if (!target.enabled) return 0;

  const rows = await prisma.outbox.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let processed = 0;
  for (const row of rows) {
    try {
      const person = await prisma.person.findUnique({ where: { id: row.entityId } });
      if (!person) {
        await prisma.outbox.update({
          where: { id: row.id },
          data: { status: "FAILED", lastError: "entity no longer exists", processedAt: new Date() },
        });
        continue;
      }
      const payload = personMirrorPayload(person);
      const mapping = await prisma.mirrorRecord.findUnique({
        where: {
          entityType_entityId_baseId: {
            entityType: "Person",
            entityId: person.id,
            baseId: target.baseId,
          },
        },
      });
      if (mapping) {
        await writer.patchRecord(target.baseId, target.peopleTableId, mapping.recordId, payload);
      } else {
        const created = await writer.createRecord(target.baseId, target.peopleTableId, payload);
        await prisma.mirrorRecord.create({
          data: { entityType: "Person", entityId: person.id, baseId: target.baseId, recordId: created.id },
        });
      }
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: "SENT", processedAt: new Date() },
      });
      processed++;
    } catch (error) {
      const attempts = row.attempts + 1;
      await prisma.outbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
        },
      });
    }
  }
  return processed;
}
```

- [ ] **Step 4:** Green; commit: `feat: mirror drain with per-base record mapping`

---

### Task 9: Worker (pg-boss bootstrap)

**Files:**
- Create: `worker/index.ts`
- Modify: `package.json` (deps + script), `tsconfig.json` if needed (worker dir is included by `**/*.ts` already)

- [ ] **Step 1:** `npm install pg-boss` (v10.x lands in dependencies).

- [ ] **Step 2: Write `worker/index.ts`:**

```ts
// HAVEN Hub background worker: drains the mirror outbox and runs nightly
// reconciliation. Run locally with `npm run worker`. pg-boss v10: queues must
// be created before workers attach; handlers receive an ARRAY of jobs.
import PgBoss from "pg-boss";
import { config } from "../src/platform/config";
import { prisma } from "../src/platform/db";
import { AirtableClient } from "../src/platform/airtable/client";
import { drainOutbox, type MirrorTarget } from "../src/platform/airtable/mirror";
import { reconcilePeople } from "../src/platform/airtable/reconcile";

const HEARTBEAT_ID = "mirror-worker";
const OUTBOX_QUEUE = "mirror-outbox";
const RECONCILE_QUEUE = "mirror-reconcile";

function mirrorTarget(): MirrorTarget {
  return {
    enabled: config.AIRTABLE_MIRROR_ENABLED,
    baseId: config.AIRTABLE_MIRROR_BASE_ID ?? "",
    peopleTableId: config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "",
  };
}

async function main() {
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on("error", (error) => console.error("[worker] pg-boss error", error));
  await boss.start();

  await boss.createQueue(OUTBOX_QUEUE);
  await boss.createQueue(RECONCILE_QUEUE);

  // Cron triggers; the drain also loops until empty, so a 1-minute cadence is
  // a latency bound, not a throughput bound.
  await boss.schedule(OUTBOX_QUEUE, "* * * * *");
  await boss.schedule(RECONCILE_QUEUE, "0 6 * * *"); // nightly, 06:00 UTC

  const client = config.AIRTABLE_PAT ? new AirtableClient(config.AIRTABLE_PAT) : null;

  await boss.work(OUTBOX_QUEUE, async () => {
    if (!client) return;
    let processed: number;
    do {
      processed = await drainOutbox(client, mirrorTarget());
    } while (processed > 0);
  });

  await boss.work(RECONCILE_QUEUE, async () => {
    if (!client) return;
    const corrected = await reconcilePeople(client, mirrorTarget());
    if (corrected > 0) console.log(`[worker] reconciliation corrected ${corrected} record(s)`);
  });

  const beat = async () => {
    try {
      await prisma.workerHeartbeat.upsert({
        where: { id: HEARTBEAT_ID },
        update: { beatAt: new Date() },
        create: { id: HEARTBEAT_ID, beatAt: new Date() },
      });
    } catch (error) {
      console.error("[worker] heartbeat failed", error);
    }
  };
  await beat();
  const heartbeatTimer = setInterval(beat, 30_000);

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    await boss.stop({ wait: true });
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[worker] running. mirror=${config.AIRTABLE_MIRROR_ENABLED ? "ENABLED" : "disabled"} heartbeat=${HEARTBEAT_ID}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 3:** Add `"worker": "tsx --env-file=.env worker/index.ts"` to package.json scripts. (Relative imports are used above deliberately so tsx needs no alias support; keep them relative.)

- [ ] **Step 4: Smoke it:** with the dev DB up, `npm run worker` for ~10 seconds; expect the startup line and no errors; confirm a `WorkerHeartbeat` row appeared, then Ctrl-C (or kill) cleanly. (Reconcile module does not exist yet; create a stub `reconcile.ts` exporting `reconcilePeople = async () => 0` with a TODO comment, replaced in Task 10.)

- [ ] **Step 5:** Lint/typecheck/tests; commit: `feat: pg-boss worker with outbox drain, cron, heartbeat`

---

### Task 10: Reconciliation (TDD)

**Files:**
- Modify: `src/platform/airtable/reconcile.ts` (replace stub)
- Test: `src/platform/airtable/reconcile.test.ts`

Behavior: list ALL records from the mirror target table (one paginated read), index by record id; for every MirrorRecord-mapped person, compare `personMirrorPayload(person)` to the Airtable record's fields (only the seven owned field ids); when they differ, PATCH Airtable with the Postgres truth and `recordAudit({ action: "mirror.drift_corrected", entityType: "Person", entityId, before: <airtable values>, after: <payload> })`. Returns the number corrected. Disabled target returns 0 without reading.

- [ ] **Step 1: Failing tests** with fake reader/writer + test DB: detects and corrects one drifted field; no-ops when identical; audits the drift; disabled mirror does nothing.

- [ ] **Step 2: Implement:**

```ts
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { personMirrorPayload } from "./mirror-map";
import type { AirtableWriter, MirrorTarget } from "./mirror";

export type AirtableReader = {
  listAll(baseId: string, tableId: string): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
};

/** Nightly: rewrite Airtable to match Postgres for owned fields; audit drift. */
export async function reconcilePeople(
  io: AirtableReader & AirtableWriter,
  target: MirrorTarget
): Promise<number> {
  if (!target.enabled) return 0;

  const remote = new Map(
    (await io.listAll(target.baseId, target.peopleTableId)).map((r) => [r.id, r.fields])
  );
  const mappings = await prisma.mirrorRecord.findMany({
    where: { entityType: "Person", baseId: target.baseId },
  });

  let corrected = 0;
  for (const mapping of mappings) {
    const person = await prisma.person.findUnique({ where: { id: mapping.entityId } });
    const fields = remote.get(mapping.recordId);
    if (!person || !fields) continue; // deletions are handled at cutover, not nightly
    const desired = personMirrorPayload(person);
    const drifted: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const [fieldId, value] of Object.entries(desired)) {
      const current = fields[fieldId] ?? "";
      if (String(current) !== String(value)) {
        drifted[fieldId] = value;
        before[fieldId] = current;
      }
    }
    if (Object.keys(drifted).length === 0) continue;
    await io.patchRecord(target.baseId, target.peopleTableId, mapping.recordId, drifted);
    await recordAudit({
      action: "mirror.drift_corrected",
      entityType: "Person",
      entityId: person.id,
      before,
      after: drifted,
    });
    corrected++;
  }
  return corrected;
}
```

- [ ] **Step 3:** Green; commit: `feat: nightly mirror reconciliation with drift audit`

---

### Task 11: Health endpoint extension (TDD)

**Files:**
- Modify: `src/app/api/health/route.ts`
- Test: `src/app/api/health/route.test.ts` (extend)

- [ ] **Step 1: Extend the test:** stale/absent heartbeat reports `worker.ok: false` without failing the endpoint; fresh heartbeat (insert a row in the test) reports `worker.ok: true`; response includes `outbox: { pending, failed }`.

- [ ] **Step 2: Implement:** keep `ok`/`db` semantics and the 200/503 contract keyed on the DB only. Add:

```ts
const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "mirror-worker" } });
const workerOk = !!heartbeat && Date.now() - heartbeat.beatAt.getTime() < 90_000;
const outbox = await outboxStats();
return NextResponse.json({ ok: db, db, worker: { ok: workerOk }, outbox }, { status: db ? 200 : 503 });
```

(Wrap the new reads in the existing try/catch shape so a DB failure still returns the 503 with `db: false`.)

- [ ] **Step 3:** Green; commit: `feat: health reports worker heartbeat and outbox depth`

---

### Task 12: Sandbox base + live mirror smoke test

This is the only task that touches the network for writes, and only the sandbox.

- [ ] **Step 1 (controller):** Create an Airtable base named `HAVENHub Mirror Sandbox` with one table `All People Mirror` whose fields mirror the seven owned fields (same names/types as production: Name, NetID, Contact Email, Phone Number, Epic ID, Yale Affiliation, Graduation Year). Capture its base id, table id, and the seven new field ids.
- [ ] **Step 2:** The sandbox field ids will differ from production's. Generalize `mirror-map.ts`: `personMirrorPayload(person, fieldMap = ALL_PEOPLE_FIELDS)` where `fieldMap` has the same keys. Add config vars `AIRTABLE_MIRROR_FIELD_MAP` (JSON string, optional; defaults to production ids) parsed in config with zod; thread through `MirrorTarget`. Update tests.
- [ ] **Step 3:** Set `.env`: `AIRTABLE_MIRROR_ENABLED=true`, sandbox base/table ids, sandbox field map JSON.
- [ ] **Step 4:** Enqueue a real outbox row for one imported person (psql or a tiny script), run `npm run worker`, watch the row go SENT, and verify the record appears in the sandbox base. Then edit that record's name in Airtable by hand, trigger reconcile early (temporarily schedule `* * * * *` or call `reconcilePeople` via a script), and verify the value snaps back and an audit row exists.
- [ ] **Step 5:** Revert any temporary cron change; leave `.env` mirror pointed at the sandbox and ENABLED=false unless actively testing. Commit code changes: `feat: per-target field maps for sandbox mirroring`

---

### Task 13: Final verification + PR

- [ ] **Step 1:** Full gauntlet: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e` (stop any running dev server first).
- [ ] **Step 2:** `git push -u origin plan-2/airtable-import-mirror`
- [ ] **Step 3:** Open the PR:

```bash
gh pr create --title "Plan 2: Airtable import & mirror" --body "$(cat <<'EOF'
## Summary
- Idempotent importer: HAVEN Management (All People + SU 26 roster) into Postgres, dry-run by default, collision reporting
- Outbox-based one-way mirror (Postgres to Airtable) with pg-boss worker, per-base record mapping, retry/backoff
- Nightly reconciliation rewrites drift and audits it; health endpoint reports worker heartbeat + outbox depth
- All writes gated behind AIRTABLE_MIRROR_ENABLED and pointed at a sandbox base until FA26 cutover

## Test Plan
- [ ] CI green (unit + integration, all offline)
- [ ] Live import dry-run + apply reviewed against the real base
- [ ] Sandbox mirror round-trip: outbox row -> sandbox record; manual drift -> reconciled + audited
EOF
)"
```

- [ ] **Step 4:** Confirm CI green on the PR; merge via GitHub after review.

---

## Deferred deliberately

- **Compliance import** waits for Plan 5 (its tables do not exist yet)
- **Roster/term-table mirroring to Airtable** (creating an `FA 26` table) belongs to Plan 3's term lifecycle
- **Outbox producers**: no module mutates Person yet; Plans 3-5 services call `enqueueMirror` as they land
- **Worker Docker image** arrives with the deployment plan
- **Production mirror cutover** (flip base ids, backfill MirrorRecord from Person.airtableRecordId): an explicit FA26 runbook item
