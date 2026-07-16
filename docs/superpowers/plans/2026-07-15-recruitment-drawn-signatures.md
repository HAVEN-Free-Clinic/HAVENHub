# Drawn Signatures for Recruitment Forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people draw an actual signature (finger/mouse/stylus, with a typed-name fallback) in place of typed initials/signatures, both as a new `SIGNATURE` field type in the application-form builder and on every agreement + initials block of the onboarding contract.

**Architecture:** A shared `SignaturePad` client primitive (thin wrapper over the `signature_pad` library) writes a `data:image/png` string into a hidden form input, so it round-trips through the existing FormData-based submit flows unchanged. Both flows persist the PNG as a private Vercel Blob (reusing `storage.ts`) with audit context (`method`, printed `name`, server-stamped `signedAt`). The application field stores a FILE-style ref in `Application.answers` (served by the existing download route); the contract stores a structured record per block in `OnboardingContract.signatures` and gets a brand-new admin view that inlines those blobs server-side.

**Tech Stack:** Next.js App Router (server + client components), Prisma/PostgreSQL, Vercel Blob (`@vercel/blob`, via `src/platform/storage.ts`), Zod, Vitest (node env, DB-backed integration tests), Playwright (e2e), Tailwind tokens + `@/platform/ui` primitives, `signature_pad` (new dependency).

## Global Constraints

- **No `tailwind-merge`.** Compose classes with `cx` from `@/platform/ui/cx`.
- **Form inputs stay uncontrolled + serialized via `new FormData(form)`.** No react-hook-form. A drawn signature must land in a *named* form `<input>` or the server never sees it.
- **Storage is private Blob via `src/platform/storage.ts` `putObject(key, bytes, "image/png")`** (`access: "private"`). Never embed signature bytes in a DB row or email.
- **`signedAt` is stamped server-side** (`new Date().toISOString()`), never trusted from the client.
- **Signature payload validation:** must be `data:image/png;base64,...`, PNG magic bytes, non-empty, and ≤ `SIGNATURE_MAX_BYTES` (1_000_000).
- **Lint:** raw `<input>`/`<button>` trigger `no-restricted-syntax`; use primitives, or add the same `// eslint-disable-next-line no-restricted-syntax -- <reason>` the surrounding code uses. No `Date.now()` in a render body (`react-hooks/purity`); use `new Date()`.
- **Prisma client is shared across worktrees** (`node_modules` symlink). `ALTER TYPE ... ADD VALUE` is additive, so `npx prisma generate` is safe for other worktrees.
- **DB-backed tests** need a per-worktree throwaway Postgres and `TEST_DATABASE_URL` (never Neon). Run `npm run test:prepare` after the migration, then `npx vitest run <path>`.
- **Prose/UI copy:** avoid em-dashes.

---

## File Structure

**New files**
- `src/platform/ui/signature-pad.tsx` — the shared `SignaturePad` client primitive.
- `src/modules/recruitment/services/signature.ts` — pure `decodeSignaturePng` + guards (shared by both server flows).
- `src/modules/recruitment/services/signature.test.ts` — unit tests for the decoder.
- `src/modules/recruitment/contract/signatures.ts` — contract signature types + `collectSignatureInputs` + `buildContractSignatureView` (pure).
- `src/modules/recruitment/contract/signatures.test.ts` — unit tests for the above.
- `src/app/(app)/recruitment/cycles/[id]/onboarding/[contractId]/page.tsx` — new admin signed-contract view.
- `prisma/migrations/20260715120000_add_signature_field_type/migration.sql` — enum add.
- `e2e/recruitment-signature.spec.ts` — Playwright: draw on the pad and submit.

**Modified files**
- `prisma/schema.prisma` — add `SIGNATURE` to `enum FieldType`.
- `src/modules/recruitment/engine/field-types.ts` — new `"Signature"` group + `FIELD_TYPE_META` entry + exported `FIELD_GROUP_LABELS`.
- `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx` — import the exported labels.
- `src/modules/recruitment/components/field-preview.tsx` — SIGNATURE placeholder.
- `src/modules/recruitment/engine/schema-builder.ts` — SIGNATURE in the union + `fieldSchema`.
- `src/app/apply/[slug]/apply-wizard.tsx` — render live `SignaturePad` for SIGNATURE.
- `src/app/apply/[slug]/wizard-review.tsx` — `imageSrc` review row.
- `src/modules/recruitment/services/submissions.ts` — persist SIGNATURE answers to Blob.
- `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` — inline signature image.
- `src/app/onboard/[token]/contract-field.tsx` — agreements + initials render `SignaturePad`.
- `src/app/onboard/[token]/actions.ts` — harvest signatures via `collectSignatureInputs`.
- `src/modules/recruitment/services/onboarding.ts` — `ContractSubmission` shape + `submitContract` persistence + `getContractForReview`.
- `src/modules/recruitment/services/onboarding.test.ts` — update to the new signature shape.
- `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx` — "View" link into the new page.
- `package.json` — add `signature_pad`.

---

## Task 1: Signature decode service + dependency

**Files:**
- Modify: `package.json`
- Create: `src/modules/recruitment/services/signature.ts`
- Test: `src/modules/recruitment/services/signature.test.ts`

**Interfaces:**
- Produces: `SIGNATURE_MAX_BYTES: number`; `class SignatureError extends Error`; `isSignatureDataUrl(v: unknown): v is string`; `decodeSignaturePng(dataUrl: string): Buffer` (throws `SignatureError` on any invalid/oversize/non-PNG input).

- [ ] **Step 1: Add the dependency**

Run: `npm install signature_pad@^5.0.0`
Expected: `package.json` gains `"signature_pad"` under `dependencies`, and it installs without peer-dep errors.

- [ ] **Step 2: Write the failing test**

Create `src/modules/recruitment/services/signature.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeSignaturePng, isSignatureDataUrl, SignatureError, SIGNATURE_MAX_BYTES } from "./signature";

// A 1x1 transparent PNG.
const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

describe("decodeSignaturePng", () => {
  it("decodes a valid image/png data URL to bytes", () => {
    const buf = decodeSignaturePng(PNG_1x1);
    expect(buf.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects a non-png data URL", () => {
    expect(() => decodeSignaturePng("data:image/jpeg;base64,/9j/4AAQ")).toThrow(SignatureError);
  });

  it("rejects an empty string", () => {
    expect(() => decodeSignaturePng("")).toThrow(SignatureError);
  });

  it("rejects a data URL whose bytes are not a PNG", () => {
    // Correct prefix, but the decoded bytes are 'hello' (no PNG magic).
    expect(() => decodeSignaturePng("data:image/png;base64,aGVsbG8=")).toThrow(SignatureError);
  });

  it("rejects an oversized payload", () => {
    const big = "A".repeat(Math.ceil((SIGNATURE_MAX_BYTES + 1024) / 3) * 4);
    expect(() => decodeSignaturePng(`data:image/png;base64,${big}`)).toThrow(SignatureError);
  });

  it("isSignatureDataUrl narrows correctly", () => {
    expect(isSignatureDataUrl(PNG_1x1)).toBe(true);
    expect(isSignatureDataUrl("nope")).toBe(false);
    expect(isSignatureDataUrl(42)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/signature.test.ts`
Expected: FAIL (`Cannot find module './signature'`).

- [ ] **Step 4: Implement the decoder**

Create `src/modules/recruitment/services/signature.ts`:

```ts
/**
 * Shared drawn-signature helpers. A signature reaches the server as a PNG data
 * URL (produced by the SignaturePad primitive). This module is the single
 * security boundary that turns that untrusted string into bytes: it enforces the
 * image/png data-URL shape, a hard size cap, and the PNG magic-byte signature
 * before any bytes are written to storage.
 */
const PNG_PREFIX = "data:image/png;base64,";

/** Hard ceiling on a decoded signature PNG. A real drawn signature is a few KB;
 *  1 MB leaves generous headroom while bounding a hostile payload. */
export const SIGNATURE_MAX_BYTES = 1_000_000;

export class SignatureError extends Error {
  constructor(message = "A valid signature is required.") {
    super(message);
    this.name = "SignatureError";
  }
}

/** True when `v` looks like a PNG data URL (prefix only; full validation is in
 *  decodeSignaturePng). */
export function isSignatureDataUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PNG_PREFIX);
}

/** Decode a PNG data URL to bytes, or throw SignatureError. Buffer.from(base64)
 *  never throws (it silently drops invalid chars), so validity is enforced by the
 *  length checks and the PNG magic-byte signature, not a try/catch. */
export function decodeSignaturePng(dataUrl: string): Buffer {
  if (!isSignatureDataUrl(dataUrl)) throw new SignatureError();
  const bytes = Buffer.from(dataUrl.slice(PNG_PREFIX.length), "base64");
  if (bytes.length === 0) throw new SignatureError();
  if (bytes.length > SIGNATURE_MAX_BYTES) throw new SignatureError("Signature image is too large.");
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) throw new SignatureError();
  return bytes;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/signature.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/recruitment/services/signature.ts src/modules/recruitment/services/signature.test.ts
git commit -m "feat(recruitment): add signature_pad dep + PNG data-URL decode service"
```

---

## Task 2: `SignaturePad` primitive

**Files:**
- Create: `src/platform/ui/signature-pad.tsx`

**Interfaces:**
- Consumes: `signature_pad` (default export, v5 API: `new SignaturePad(canvas, opts)`, `.toDataURL("image/png")`, `.fromDataURL()`, `.fromData()`, `.toData()`, `.clear()`, `.addEventListener("endStroke", fn)`).
- Produces: `SignaturePad(props)` component. Props: `{ name: string; label: string; required?: boolean; personName?: string; defaultValue?: string; error?: string; onChange?: () => void }`. Writes three hidden inputs: `name` (PNG data URL), `${name}__method` (`draw`|`type`), `${name}__name` (printed name).

> **Verification note:** the repo has no DOM test harness (node env, no testing-library/jsdom). This component is verified end-to-end in Task 13 (Playwright drives the real canvas). Here we only build it and confirm it typechecks/lints/builds.

- [ ] **Step 1: Implement the component**

Create `src/platform/ui/signature-pad.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import SignaturePadLib from "signature_pad";
import { Button } from "@/platform/ui/button";
import { cx } from "@/platform/ui/cx";

// Cross-platform cursive stack for the typed-name fallback. Availability varies,
// but the legal record is the stored typed name; the cursive face is cosmetic.
const TYPED_FONT = "'Snell Roundhand', 'Segoe Script', 'Bradley Hand', cursive";

/**
 * Draw-a-signature control with a typed-name fallback. Always outputs a PNG data
 * URL into a hidden <input name={name}> so it serializes through the owning
 * form's FormData with no submit-plumbing changes. Companion hidden inputs record
 * the method (draw/type) and the printed name for the audit trail.
 */
export function SignaturePad({
  name,
  label,
  required = false,
  personName = "",
  defaultValue = "",
  error,
  onChange,
}: {
  name: string;
  label: string;
  required?: boolean;
  personName?: string;
  defaultValue?: string;
  error?: string;
  onChange?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);
  const hiddenRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState("");
  const [empty, setEmpty] = useState(!defaultValue);

  // Push the current PNG (or "") into the hidden input the form serializes, and
  // notify the owner so autosave can pick it up.
  function commit(dataUrl: string) {
    if (hiddenRef.current) hiddenRef.current.value = dataUrl;
    setEmpty(!dataUrl);
    onChange?.();
  }

  // Refit the canvas backing store to its CSS box at the current devicePixelRatio,
  // preserving the drawing. A canvas inside a display:none wizard step has zero
  // size, so this reruns when the pad becomes visible (via ResizeObserver).
  function resize() {
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const data = pad.toData();
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.getContext("2d")?.scale(ratio, ratio);
    pad.clear();
    if (data.length) pad.fromData(data);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    // SSR / no-2d-context guard (also the unit-test env): cannot draw, render inert.
    if (!canvas || !canvas.getContext("2d")) return;
    const pad = new SignaturePadLib(canvas, { penColor: "#0f172a", backgroundColor: "rgba(0,0,0,0)" });
    padRef.current = pad;
    const onEnd = () => commit(pad.toDataURL("image/png"));
    pad.addEventListener("endStroke", onEnd);
    if (defaultValue) pad.fromDataURL(defaultValue);
    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      pad.removeEventListener("endStroke", onEnd);
      padRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time init; defaultValue seeds, never re-runs
  }, []);

  function clear() {
    padRef.current?.clear();
    setTyped("");
    commit("");
  }

  // Rasterize the typed name in a cursive face so the stored artifact is always a
  // PNG, giving every display surface a single (image) render path.
  function renderTyped(value: string) {
    setTyped(value);
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    pad.clear();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!value.trim()) { commit(""); return; }
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const w = canvas.width / ratio;
    const h = canvas.height / ratio;
    ctx.fillStyle = "#0f172a";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `italic ${Math.min(h * 0.5, 44)}px ${TYPED_FONT}`;
    ctx.fillText(value, w / 2, h / 2);
    commit(canvas.toDataURL("image/png"));
  }

  return (
    <div className="block">
      <span className="block text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-critical" aria-hidden="true"> *</span>}
      </span>

      <input ref={hiddenRef} type="hidden" name={name} defaultValue={defaultValue} />
      <input type="hidden" name={`${name}__method`} value={mode} readOnly />
      <input type="hidden" name={`${name}__name`} value={mode === "type" ? typed : personName} readOnly />

      {mode === "draw" ? (
        <div className={cx("mt-1.5 rounded-lg border bg-surface", error ? "border-critical" : "border-border-strong")}>
          <canvas ref={canvasRef} aria-label={`${label} signature pad`} className="h-40 w-full touch-none rounded-lg" />
        </div>
      ) : (
        // eslint-disable-next-line no-restricted-syntax -- cursive-styled typed-signature field; no primitive supports the font override
        <input
          type="text"
          value={typed}
          onChange={(e) => renderTyped(e.target.value)}
          placeholder="Type your full name"
          aria-label={`${label} typed signature`}
          className={cx("mt-1.5 w-full rounded-lg border bg-surface px-3 py-2 text-2xl", error ? "border-critical" : "border-border-strong")}
          style={{ fontFamily: TYPED_FONT }}
        />
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={clear}>Clear</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => { clear(); setMode((m) => (m === "draw" ? "type" : "draw")); }}>
          {mode === "draw" ? "Type instead" : "Draw instead"}
        </Button>
        {!empty && <span className="text-xs text-success">Signed</span>}
      </div>

      {error && <span className="mt-1 block text-xs text-critical">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks and lints**

Run: `npx tsc --noEmit && npx eslint src/platform/ui/signature-pad.tsx`
Expected: no errors. If `Button` has no `variant="outline"`/`size="sm"`, open `src/platform/ui/button.tsx` and use the actual prop names (the builder `type-picker.tsx` uses `variant="outline" size="sm"`, so they exist).

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/signature-pad.tsx
git commit -m "feat(ui): SignaturePad primitive (draw + typed-name fallback)"
```

---

## Task 3: Add `SIGNATURE` to the `FieldType` enum

**Files:**
- Modify: `prisma/schema.prisma:480-493`
- Create: `prisma/migrations/20260715120000_add_signature_field_type/migration.sql`

- [ ] **Step 1: Add the enum value**

In `prisma/schema.prisma`, add `SIGNATURE` as the last member of `enum FieldType`:

```prisma
enum FieldType {
  SHORT_TEXT
  LONG_TEXT
  SINGLE_SELECT
  MULTI_SELECT
  CHECKBOX
  EMAIL
  PHONE
  NUMBER
  DATE
  FILE
  DEPARTMENT_CHOICE
  SUBCOMMITTEE_RANK
  SIGNATURE
}
```

- [ ] **Step 2: Write the migration by hand**

Create `prisma/migrations/20260715120000_add_signature_field_type/migration.sql`:

```sql
-- Add the SIGNATURE value to the FieldType enum so application-form builders can
-- add a draw-your-signature field (persisted as a private PNG blob, like FILE).
ALTER TYPE "FieldType" ADD VALUE 'SIGNATURE';
```

- [ ] **Step 3: Regenerate the client and apply to the test DB**

Run: `npx prisma generate && npm run test:prepare`
Expected: client regenerates; `prisma migrate deploy` applies `20260715120000_add_signature_field_type` to the test database with no drift.

- [ ] **Step 4: Verify the enum is present**

Run: `node -e "const {FieldType}=require('@prisma/client'); if(!FieldType.SIGNATURE) throw new Error('missing'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260715120000_add_signature_field_type/migration.sql
git commit -m "feat(recruitment): add SIGNATURE FieldType enum value + migration"
```

---

## Task 4: Register SIGNATURE in the field-type registry + builder

**Files:**
- Modify: `src/modules/recruitment/engine/field-types.ts`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx:8-11,53-56`
- Modify: `src/modules/recruitment/components/field-preview.tsx`
- Test: `src/modules/recruitment/engine/field-types.test.ts`

**Interfaces:**
- Produces: `FIELD_TYPE_META.SIGNATURE`; `FieldGroup` union gains `"Signature"`; `FIELD_GROUP_LABELS: Record<FieldGroup, string>` exported from `field-types.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/recruitment/engine/field-types.test.ts` (create it if absent, importing what the other tests use):

```ts
import { describe, expect, it } from "vitest";
import { FIELD_TYPE_META, FIELD_GROUP_ORDER, FIELD_GROUP_LABELS, fieldTypesByGroup } from "./field-types";

describe("SIGNATURE field type registration", () => {
  it("has a registry entry in a Signature group", () => {
    expect(FIELD_TYPE_META.SIGNATURE).toBeDefined();
    expect(FIELD_TYPE_META.SIGNATURE.group).toBe("Signature");
    expect(FIELD_TYPE_META.SIGNATURE.hasOptions).toBe(false);
    expect(FIELD_TYPE_META.SIGNATURE.isFile).toBe(false);
  });

  it("groups SIGNATURE under Signature", () => {
    const sig = fieldTypesByGroup().find((g) => g.group === "Signature");
    expect(sig?.types).toContain("SIGNATURE");
  });

  it("every group in FIELD_GROUP_ORDER has a label (guards the missing-Subcommittee bug)", () => {
    for (const group of FIELD_GROUP_ORDER) {
      expect(FIELD_GROUP_LABELS[group]).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/recruitment/engine/field-types.test.ts`
Expected: FAIL (`FIELD_GROUP_LABELS` not exported; `SIGNATURE` undefined).

- [ ] **Step 3: Update `field-types.ts`**

Add the icon import, the `"Signature"` group, the meta entry, the group order, and the exported labels. Replace the import line and add below `FIELD_GROUP_ORDER`:

```ts
import type { FieldType } from "@prisma/client";
import {
  Type, AlignLeft, ChevronDownSquare, ListChecks, CheckSquare,
  Mail, Phone, Hash, Calendar, Paperclip, Building2, ListOrdered, PenLine, type LucideIcon,
} from "lucide-react";

export type FieldGroup = "Text" | "Choice" | "Contact" | "DateNumber" | "File" | "Department" | "Subcommittee" | "Signature";
```

Add the `SIGNATURE` entry as the last member of `FIELD_TYPE_META`:

```ts
  SUBCOMMITTEE_RANK: { label: "Subcommittee ranking", icon: ListOrdered, group: "Subcommittee", hasOptions: false, isFile: false },
  SIGNATURE: { label: "Signature (drawn)", icon: PenLine, group: "Signature", hasOptions: false, isFile: false },
};
```

Extend `FIELD_GROUP_ORDER` and add `FIELD_GROUP_LABELS` (co-located with the groups, so labels are unit-testable and can never drift from the group list):

```ts
export const FIELD_GROUP_ORDER: FieldGroup[] = ["Text", "Choice", "Contact", "DateNumber", "File", "Department", "Subcommittee", "Signature"];

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  Text: "Text",
  Choice: "Choice",
  Contact: "Contact",
  DateNumber: "Date & number",
  File: "File",
  Department: "Department",
  Subcommittee: "Subcommittee",
  Signature: "Signature",
};
```

- [ ] **Step 4: Point `type-picker.tsx` at the shared labels**

In `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx`, delete the local `GROUP_LABELS` const (lines 8-11), import the shared one, and use it:

```ts
import { fieldTypesByGroup, FIELD_TYPE_META, FIELD_GROUP_LABELS } from "@/modules/recruitment/engine/field-types";
```

Then in the grouped branch (was line 55), replace `GROUP_LABELS[group]` with `FIELD_GROUP_LABELS[group]`:

```tsx
                <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">{FIELD_GROUP_LABELS[group]}</p>
```

- [ ] **Step 5: Add the SIGNATURE placeholder to `field-preview.tsx`**

`field-preview.tsx` is used for the builder preview (and reused in the contract custom-question path, where SIGNATURE is never offered). Render a static, non-interactive placeholder so the builder preview stays lightweight; the *live* pad is wired into the apply wizard in Task 6. Add this case inside the `switch (f.type)` (for example just before `default:` at line 149):

```tsx
    case "SIGNATURE":
      control = (
        <div className="mt-1.5 flex h-24 items-center justify-center rounded-lg border border-dashed border-border-strong bg-muted text-xs text-muted-foreground">
          Applicant will sign here
        </div>
      );
      break;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/engine/field-types.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/engine/field-types.ts src/app/\(app\)/recruitment/cycles/\[id\]/builder/type-picker.tsx src/modules/recruitment/components/field-preview.tsx src/modules/recruitment/engine/field-types.test.ts
git commit -m "feat(recruitment): register SIGNATURE field type in builder registry"
```

---

## Task 5: SIGNATURE validation in the answer schema

**Files:**
- Modify: `src/modules/recruitment/engine/schema-builder.ts:9-21,58-122`
- Test: `src/modules/recruitment/engine/schema-builder.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `fieldSchema` handles `SIGNATURE` (required = a non-empty `data:image/png;base64,` string; optional = that or `""`). The union type `FieldType` in this file gains `"SIGNATURE"`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/recruitment/engine/schema-builder.test.ts`:

```ts
describe("SIGNATURE validation", () => {
  const sig = (required: boolean): SectionDef[] => [
    { id: "s", appliesTo: "BOTH", departmentCode: null,
      fields: [{ key: "sign", type: "SIGNATURE", required, options: null, validation: null }] },
  ];
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("accepts a png data URL for a required signature", () => {
    expect(buildApplicationSchema(sig(true), ctx).safeParse({ sign: PNG }).success).toBe(true);
  });
  it("rejects an empty required signature", () => {
    expect(buildApplicationSchema(sig(true), ctx).safeParse({ sign: "" }).success).toBe(false);
  });
  it("rejects a non-png value for a required signature", () => {
    expect(buildApplicationSchema(sig(true), ctx).safeParse({ sign: "typed name" }).success).toBe(false);
  });
  it("allows an empty optional signature", () => {
    expect(buildApplicationSchema(sig(false), ctx).safeParse({ sign: "" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/recruitment/engine/schema-builder.test.ts`
Expected: FAIL (SIGNATURE falls into `default: z.any().optional()`, so the required-empty and non-png cases wrongly pass).

- [ ] **Step 3: Add SIGNATURE to the union and `fieldSchema`**

In `src/modules/recruitment/engine/schema-builder.ts`, add `"SIGNATURE"` to the `FieldType` union (after `"SUBCOMMITTEE_RANK"`):

```ts
export type FieldType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "SINGLE_SELECT"
  | "MULTI_SELECT"
  | "CHECKBOX"
  | "EMAIL"
  | "PHONE"
  | "NUMBER"
  | "DATE"
  | "FILE"
  | "DEPARTMENT_CHOICE"
  | "SUBCOMMITTEE_RANK"
  | "SIGNATURE";
```

Add a `case` in `fieldSchema`, immediately before `case "FILE":`:

```ts
    case "SIGNATURE": {
      // The pad submits a PNG data URL string. Required means one must be present;
      // it is converted to a Blob file-ref in submissions.ts after validation.
      const s = z.string().startsWith("data:image/png;base64,");
      return field.required ? s : z.union([s, z.literal("")]).optional();
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/engine/schema-builder.test.ts`
Expected: PASS (all, including the 4 new cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/schema-builder.ts src/modules/recruitment/engine/schema-builder.test.ts
git commit -m "feat(recruitment): validate SIGNATURE answers as png data URLs"
```

---

## Task 6: Render the live SignaturePad in the apply wizard + review

**Files:**
- Modify: `src/app/apply/[slug]/apply-wizard.tsx:18-20,437-464,271-294`
- Modify: `src/app/apply/[slug]/wizard-review.tsx:5-6,22-40,61-69`

**Interfaces:**
- Consumes: `SignaturePad` (Task 2); `formatFieldValue` (existing).
- Produces: `ReviewRow` gains optional `imageSrc?: string`.

> **Verification note:** client rendering is verified in Task 13 (e2e). Here: typecheck + build.

- [ ] **Step 1: Import `SignaturePad` in the wizard**

In `src/app/apply/[slug]/apply-wizard.tsx`, add to the imports (near line 18):

```tsx
import { SignaturePad } from "@/platform/ui/signature-pad";
```

- [ ] **Step 2: Render SIGNATURE as the live pad**

In the section-step field map (the `steps.map(...)` block around lines 442-459), add a SIGNATURE branch alongside the existing FILE special-case. Replace the ternary that starts `f.type === "FILE" ? (...) : (<FieldPreview .../>)` with a three-way branch:

```tsx
                  {visibleFields(st.section.fields, effectiveAnswers).map((f) =>
                    f.type === "SIGNATURE" ? (
                      <SignaturePad
                        key={f.key}
                        name={f.key}
                        label={f.label}
                        required={f.required}
                        personName={[prefill?.values.first_name ?? initialAnswers.first_name, prefill?.values.last_name ?? initialAnswers.last_name].filter(Boolean).join(" ")}
                        defaultValue={typeof initialAnswers[f.key] === "string" ? (initialAnswers[f.key] as string) : ""}
                        error={fieldErrors[f.key]}
                        onChange={scheduleSave}
                      />
                    ) : f.type === "FILE" ? (
                      <div key={f.key} onChange={(e) => { e.stopPropagation(); handleFileChange(f.key, e as unknown as React.ChangeEvent<HTMLInputElement>); }}>
                        <FieldPreview f={f} departments={def.departments} subcommittees={def.subcommittees}
                          fieldError={fieldErrors[f.key]} onValueChange={handleValueChange}
                          prefill={undefined} locked={lockedKeys.has(f.key)} />
                        {fileStatus[f.key] && <p className="mt-1 text-xs text-muted-foreground" role="status" aria-live="polite">{fileStatus[f.key]}</p>}
                      </div>
                    ) : (
                      <FieldPreview key={f.key} f={f} departments={def.departments} subcommittees={def.subcommittees}
                        fieldError={fieldErrors[f.key]}
                        onValueChange={handleValueChange}
                        prefill={prefill?.values[f.key] ?? initialAnswers[f.key]} locked={lockedKeys.has(f.key)} />
                    ),
                  )}
```

- [ ] **Step 3: Add `imageSrc` to the review row model + rendering**

In `src/app/apply/[slug]/wizard-review.tsx`, extend `ReviewRow` and render the image. Replace `export type ReviewRow` and the `<dd>` block:

```tsx
export type ReviewRow = { label: string; value: string; imageSrc?: string };
```

Add a SIGNATURE case to `formatFieldValue` (before `default:`):

```tsx
    case "SIGNATURE":
      return one ? "Signed" : "";
```

In `WizardReview`, render `imageSrc` when present (replace the `<dd>` at lines 65-67):

```tsx
                <dd className="text-sm text-foreground">
                  {r.imageSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element -- inline signature data URL, not a remote asset
                    <img src={r.imageSrc} alt={`${r.label} signature`} className="h-16 rounded border border-border-subtle bg-surface" />
                  ) : (
                    r.value || <span className="italic text-subtle-foreground">Not provided</span>
                  )}
                </dd>
```

- [ ] **Step 4: Populate `imageSrc` in `buildGroups`**

In `apply-wizard.tsx`, update the section-row map inside `buildGroups` (line 289) to attach the signature data URL:

```tsx
          rows: visibleFields(st.section.fields, effectiveAnswers).map((f) => {
            const src = f.type === "SIGNATURE" && typeof values[f.key] === "string" && String(values[f.key]).startsWith("data:") ? String(values[f.key]) : undefined;
            return { label: f.label, value: src ? "" : formatFieldValue(f, values, def.subcommittees), imageSrc: src };
          }),
```

- [ ] **Step 5: Verify typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: compiles. (`missingRequiredKeys` already flags an empty required SIGNATURE because its hidden input serializes to `""`; no change needed there.)

- [ ] **Step 6: Commit**

```bash
git add src/app/apply/\[slug\]/apply-wizard.tsx src/app/apply/\[slug\]/wizard-review.tsx
git commit -m "feat(recruitment): render drawn-signature field in the apply wizard + review"
```

---

## Task 7: Persist SIGNATURE answers to Blob on submit

**Files:**
- Modify: `src/modules/recruitment/services/submissions.ts:1-15,284-292`
- Test: `src/modules/recruitment/services/submissions.test.ts`

**Interfaces:**
- Consumes: `decodeSignaturePng`, `SignatureError` (Task 1); `putObject` (`@/platform/storage`); `randomUUID` (`node:crypto`).
- Produces: a SIGNATURE answer stored in `Application.answers[key]` as `{ storedName, fileName: "signature.png", mimeType: "image/png", size, method, name, signedAt }`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/recruitment/services/submissions.test.ts`. Reuse the file's existing helpers (`openVolunteerCycle`, `addField`, `getObject`, `config`):

```ts
it("stores a drawn SIGNATURE answer as a private png blob with audit context", async () => {
  const { cycle } = await openVolunteerCycle();
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "Signature", type: "SIGNATURE", required: true });

  const PNG_1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: {
      first_name: "Sig", last_name: "Ner", email: "sig@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x",
      signature: PNG_1x1, signature__method: "draw", signature__name: "Sig Ner",
    },
    files: {},
  });

  const answers = app.answers as Record<string, { storedName?: string; mimeType?: string; method?: string; name?: string; signedAt?: string }>;
  const sig = answers.signature;
  expect(sig.mimeType).toBe("image/png");
  expect(sig.method).toBe("draw");
  expect(sig.name).toBe("Sig Ner");
  expect(typeof sig.signedAt).toBe("string");
  // The raw data URL and the companion keys must not linger in stored answers.
  expect(typeof answers.signature).toBe("object");
  expect((answers as Record<string, unknown>).signature__method).toBeUndefined();
  // The blob exists in storage.
  const bytes = await getObject(`recruitment/${cycle.id}/${sig.storedName}`);
  expect(bytes?.length).toBeGreaterThan(0);
});

it("rejects a required SIGNATURE that was not signed", async () => {
  const { cycle } = await openVolunteerCycle();
  const idSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(idSection.id, { label: "Signature", type: "SIGNATURE", required: true });
  void cycle;
  await expect(
    submitApplication("apply-v", {
      applicantType: "NEW",
      answers: { first_name: "No", last_name: "Sign", email: "nosign@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x", signature: "" },
      files: {},
    }),
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts -t "SIGNATURE"`
Expected: FAIL (the stored answer is still the raw data-URL string; no blob written).

- [ ] **Step 3: Add imports**

At the top of `src/modules/recruitment/services/submissions.ts`, extend the imports:

```ts
import { randomUUID } from "node:crypto";
import { putObject } from "@/platform/storage";
import { decodeSignaturePng, SignatureError } from "./signature";
```

- [ ] **Step 4: Persist signatures after the visibility-strip loop**

In `submitApplication`, immediately after the `for (const field of visibleFields)` strip loop (which ends near line 292, before `let application: Application;`), insert:

```ts
  // Drawn signatures: each SIGNATURE answer arrived as a PNG data URL. Store it as
  // a private blob (like FILE) and replace the answer with a file-ref carrying the
  // audit context (method + printed name + server-stamped signedAt). Companion
  // keys (`${key}__method` / `${key}__name`) live only in the raw input.answers;
  // the zod object stripped them, so they never reach answersWithFiles.
  const signatureStorageKeys: string[] = [];
  for (const field of visibleFields) {
    if (field.type !== "SIGNATURE") continue;
    if (!isFieldVisible(field.visibleWhen, ctx.answers)) continue;
    const raw = (answersWithFiles as Record<string, unknown>)[field.key];
    if (typeof raw !== "string" || raw === "") { delete (answersWithFiles as Record<string, unknown>)[field.key]; continue; }
    let bytes: Buffer;
    try {
      bytes = decodeSignaturePng(raw);
    } catch (err) {
      if (err instanceof SignatureError) throw new SubmissionValidationError("Please provide a valid signature.", { [field.key]: "invalid signature" });
      throw err;
    }
    const safeKey = field.key.replace(/[^a-z0-9_]/gi, "_");
    const storedName = `${safeKey}-${randomUUID()}.png`;
    const storageKey = `recruitment/${cycle.id}/${storedName}`;
    await putObject(storageKey, bytes, "image/png");
    signatureStorageKeys.push(storageKey);
    const rawMethod = input.answers[`${field.key}__method`];
    const rawName = input.answers[`${field.key}__name`];
    (answersWithFiles as Record<string, unknown>)[field.key] = {
      storedName,
      fileName: "signature.png",
      mimeType: "image/png",
      size: bytes.length,
      method: rawMethod === "type" ? "type" : "draw",
      name: typeof rawName === "string" ? rawName.trim() : "",
      signedAt: new Date().toISOString(),
    };
  }
```

- [ ] **Step 5: Include signature blobs in rollback cleanup**

In the two `await cleanupFiles(fileRefs.storageKeys);` calls inside the `catch (err)` block (lines 354 and 357), append the signature keys so a failed transaction drops them too:

```ts
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      await cleanupFiles([...fileRefs.storageKeys, ...signatureStorageKeys]);
      throw new DuplicateApplicationError();
    }
    await cleanupFiles([...fileRefs.storageKeys, ...signatureStorageKeys]);
    throw err;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): persist drawn SIGNATURE answers as private png blobs"
```

---

## Task 8: Show the signature image on the admin applicant detail

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:104-131`

> **Verification note:** server-rendered; verified by the e2e in Task 13 and by manual check. No new unit test (the page is a data-driven server component with no extracted logic).

- [ ] **Step 1: Render SIGNATURE answers as an inline image**

In the `section.fields.map((f) => { ... })` block, treat SIGNATURE like a file-ref but render it as an image via the existing download route (which already serves `image/png` inline). Replace the `fileVal`/`display`/return block (lines 105-130):

```tsx
              const val = answers[f.key];
              const isFileLike = (f.type === "FILE" || f.type === "SIGNATURE") && val && typeof val === "object";
              const fileVal = isFileLike ? (val as { storedName?: string; fileName?: string }) : null;
              const display = fileVal
                ? fileVal.fileName ?? "(file)"
                : Array.isArray(val) ? val.join(", ") : val === undefined || val === "" ? "(none)" : String(val);
              const fileHref = `/api/recruitment/applications/${applicationId}/files/${encodeURIComponent(f.key)}?inline=1`;
              return (
                <div key={f.id}>
                  <dt className="text-xs text-subtle-foreground">{f.label}</dt>
                  <dd className="mt-0.5 text-sm text-foreground">
                    {f.type === "SIGNATURE" && fileVal?.storedName ? (
                      // eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin file route, not a remote asset
                      <img src={fileHref} alt={`${f.label} signature`} className="h-20 rounded border border-border-subtle bg-surface" />
                    ) : fileVal?.storedName ? (
                      <a href={fileHref} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-fg hover:underline">
                        {display}
                      </a>
                    ) : (
                      display
                    )}
                  </dd>
                </div>
              );
```

- [ ] **Step 2: Verify typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/recruitment/cycles/\[id\]/applicants/\[applicationId\]/page.tsx
git commit -m "feat(recruitment): show drawn signature inline on applicant detail"
```

---

## Task 9: Contract signature types + pure helpers

**Files:**
- Create: `src/modules/recruitment/contract/signatures.ts`
- Test: `src/modules/recruitment/contract/signatures.test.ts`

**Interfaces:**
- Consumes: `ContractLayout`, `AgreementBlock` (`./layout`).
- Produces:
  - `type SignatureMethod = "draw" | "type"`
  - `type SignatureInput = { dataUrl: string; method: SignatureMethod; name: string }`
  - `type StoredSignature = { method: SignatureMethod; name: string; imageKey: string; signedAt: string }`
  - `isStoredSignature(v: unknown): v is StoredSignature`
  - `collectSignatureInputs(entries: Iterable<[string, string]>): Record<string, SignatureInput>` — groups `sig__<id>` + `sig__<id>__method` + `sig__<id>__name`.
  - `type ContractSignatureRow = { blockId: string; title: string; method: SignatureMethod | null; name: string; signedAt: string | null; imageKey: string | null; legacyText: string | null }`
  - `buildContractSignatureView(layout: ContractLayout, signatures: unknown): ContractSignatureRow[]`

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/contract/signatures.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectSignatureInputs, buildContractSignatureView, isStoredSignature } from "./signatures";
import type { ContractLayout } from "./layout";

describe("collectSignatureInputs", () => {
  it("groups a base signature with its method and name companions", () => {
    const entries: [string, string][] = [
      ["sig__agreement", "data:image/png;base64,AAA"],
      ["sig__agreement__method", "draw"],
      ["sig__agreement__name", "Ada Lovelace"],
      ["sig__initials", "data:image/png;base64,BBB"],
      ["sig__initials__method", "type"],
      ["sig__initials__name", "AL"],
      ["unrelated", "ignore me"],
    ];
    const out = collectSignatureInputs(entries);
    expect(out.agreement).toEqual({ dataUrl: "data:image/png;base64,AAA", method: "draw", name: "Ada Lovelace" });
    expect(out.initials).toEqual({ dataUrl: "data:image/png;base64,BBB", method: "type", name: "AL" });
    expect(out.unrelated).toBeUndefined();
  });

  it("defaults method to draw and name to empty when companions are absent", () => {
    const out = collectSignatureInputs([["sig__training", "data:image/png;base64,CCC"]]);
    expect(out.training).toEqual({ dataUrl: "data:image/png;base64,CCC", method: "draw", name: "" });
  });
});

describe("buildContractSignatureView", () => {
  const layout: ContractLayout = {
    blocks: [
      { kind: "agreement", id: "agreement", title: "Volunteer agreement", body: "", signatureLabel: "sign" },
      { kind: "system_field", systemKey: "initials" },
    ],
  };

  it("maps a new drawn signature to an imageKey row", () => {
    const rows = buildContractSignatureView(layout, {
      agreement: { method: "draw", name: "Ada", imageKey: "onboarding/c1/sig-agreement.png", signedAt: "2026-07-15T00:00:00.000Z" },
    });
    const row = rows.find((r) => r.blockId === "agreement")!;
    expect(row.title).toBe("Volunteer agreement");
    expect(row.imageKey).toBe("onboarding/c1/sig-agreement.png");
    expect(row.legacyText).toBeNull();
    expect(row.name).toBe("Ada");
  });

  it("maps a legacy typed-name string to a legacyText row", () => {
    const rows = buildContractSignatureView(layout, { agreement: "Ada Lovelace" });
    const row = rows.find((r) => r.blockId === "agreement")!;
    expect(row.legacyText).toBe("Ada Lovelace");
    expect(row.imageKey).toBeNull();
  });

  it("includes an Initials row when the initials system field is enabled", () => {
    const rows = buildContractSignatureView(layout, {});
    expect(rows.some((r) => r.blockId === "initials" && r.title === "Initials")).toBe(true);
  });
});

describe("isStoredSignature", () => {
  it("accepts the stored object shape and rejects a plain string", () => {
    expect(isStoredSignature({ method: "draw", name: "x", imageKey: "k", signedAt: "t" })).toBe(true);
    expect(isStoredSignature("typed name")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/signatures.test.ts`
Expected: FAIL (`Cannot find module './signatures'`).

- [ ] **Step 3: Implement `signatures.ts`**

Create `src/modules/recruitment/contract/signatures.ts`:

```ts
import type { ContractLayout } from "./layout";

export type SignatureMethod = "draw" | "type";

/** What the SignaturePad submits for one signable block. */
export type SignatureInput = { dataUrl: string; method: SignatureMethod; name: string };

/** What we persist per block in OnboardingContract.signatures JSON (new contracts). */
export type StoredSignature = { method: SignatureMethod; name: string; imageKey: string; signedAt: string };

const SIG_PREFIX = "sig__";

export function isStoredSignature(v: unknown): v is StoredSignature {
  return (
    v != null && typeof v === "object" &&
    typeof (v as StoredSignature).imageKey === "string" &&
    typeof (v as StoredSignature).signedAt === "string"
  );
}

/**
 * Group flat form entries into per-block SignatureInput. The pad writes three
 * inputs per block: `sig__<id>` (data URL), `sig__<id>__method`, `sig__<id>__name`.
 * The `__method` / `__name` suffixes are matched first so a block id never
 * collides with a companion (agreement ids never end in those suffixes).
 */
export function collectSignatureInputs(entries: Iterable<[string, string]>): Record<string, SignatureInput> {
  const out: Record<string, SignatureInput> = {};
  const ensure = (id: string): SignatureInput => (out[id] ??= { dataUrl: "", method: "draw", name: "" });
  for (const [key, value] of entries) {
    if (!key.startsWith(SIG_PREFIX)) continue;
    const rest = key.slice(SIG_PREFIX.length);
    if (rest.endsWith("__method")) {
      ensure(rest.slice(0, -"__method".length)).method = value === "type" ? "type" : "draw";
    } else if (rest.endsWith("__name")) {
      ensure(rest.slice(0, -"__name".length)).name = value.trim();
    } else {
      ensure(rest).dataUrl = value;
    }
  }
  return out;
}

export type ContractSignatureRow = {
  blockId: string;
  title: string;
  method: SignatureMethod | null;
  name: string;
  signedAt: string | null;
  imageKey: string | null;   // new drawn signature (server inlines the blob)
  legacyText: string | null; // pre-feature contracts stored a typed name string
};

/**
 * Normalize a contract's stored signatures into display rows, one per agreement
 * block plus an Initials row when that system field is enabled. Handles both the
 * new object shape (StoredSignature) and the legacy typed-name string shape.
 */
export function buildContractSignatureView(layout: ContractLayout, signatures: unknown): ContractSignatureRow[] {
  const map = (signatures ?? {}) as Record<string, unknown>;
  const rows: ContractSignatureRow[] = [];

  const rowFor = (blockId: string, title: string): ContractSignatureRow => {
    const raw = map[blockId];
    if (isStoredSignature(raw)) {
      return { blockId, title, method: raw.method, name: raw.name, signedAt: raw.signedAt, imageKey: raw.imageKey, legacyText: null };
    }
    if (typeof raw === "string" && raw.trim()) {
      return { blockId, title, method: null, name: raw, signedAt: null, imageKey: null, legacyText: raw };
    }
    return { blockId, title, method: null, name: "", signedAt: null, imageKey: null, legacyText: null };
  };

  for (const b of layout.blocks) {
    if (b.kind === "agreement") rows.push(rowFor(b.id, b.title));
  }
  const initialsEnabled = layout.blocks.some(
    (b) => b.kind === "system_field" && b.systemKey === "initials" && b.enabled !== false,
  );
  if (initialsEnabled) rows.push(rowFor("initials", "Initials"));
  return rows;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/signatures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/signatures.ts src/modules/recruitment/contract/signatures.test.ts
git commit -m "feat(recruitment): contract signature types + collect/view helpers"
```

---

## Task 10: Persist drawn contract signatures in `submitContract`

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts:1-16,182-206,220-352`
- Modify: `src/modules/recruitment/services/onboarding.test.ts`

**Interfaces:**
- Consumes: `decodeSignaturePng`, `SignatureError` (Task 1); `SignatureInput`, `StoredSignature` (Task 9); `putObject`, `deleteObject`.
- Produces: `ContractSubmission.signatures` changes to `Record<string, SignatureInput>` (keys = agreement ids + `"initials"`); the `initials: string` field is removed. `submitContract` writes `signatures` as `Record<string, StoredSignature>` and sets the `initials` column to the initials block's printed name. New export `getContractForReview(contractId)`.

- [ ] **Step 1: Update the existing tests to the new signature shape**

`onboarding.test.ts` seeds a PENDING contract with its existing helpers: `const { srr, acceptance } = await seed();` then `const c = await createOrResendContract(acceptance.id, srr.id, "http://test");`, and submits with `c.token`. Every `submitContract` call currently passes string signatures plus a top-level `initials`. Add a `sign` helper near the top of the file and add `import { getObject } from "@/platform/storage";`:

```ts
import type { SignatureInput } from "../contract/signatures";
const SIG_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
const sign = (name: string): SignatureInput => ({ dataUrl: SIG_PNG, method: "draw", name });
```

Convert every `submitContract(...)` input object with these semantics-preserving rules (a signature counts as present iff its `dataUrl` is non-empty, exactly as the old code checked `.trim()` on the typed name):

- `signatures: { agreement: "Ada", professionalism: "Ada", training: "Ada" }, initials: "AL"` becomes `signatures: { agreement: sign("Ada"), professionalism: sign("Ada"), training: sign("Ada"), initials: sign("AL") }` and the top-level `initials` key is deleted.
- The "empty agreement is rejected" case (`agreement: ""`) becomes `agreement: { dataUrl: "", method: "draw", name: "" }` (still rejected: no data URL).
- The "initials disabled" test keeps no `initials` entry in `signatures` and drops its top-level `initials: ""`.
- Any `base` object carrying `initials: "..."` moves it into `signatures.initials` the same way.

The error key for a missing initials signature changes from `initials` to `sig__initials`; the existing tests assert only `toBeInstanceOf(ContractValidationError)` (not the key), so they stay green.

Then add the new coverage test. `createOrResendContract` freezes `resolveContractLayout(cycle.id)` into `templateSnapshot`; with no per-cycle override that is `DEFAULT_CONTRACT_LAYOUT`, whose VOLUNTEER agreements are `agreement` / `professionalism` / `training` plus an enabled `initials` field:

```ts
it("stores each contract signature as a blob-backed structured record", async () => {
  const { srr, acceptance } = await seed();
  const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
  await submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu",
    signatures: { agreement: sign("Ada"), professionalism: sign("Ada"), training: sign("Ada"), initials: sign("Ada L") },
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
    hipaaCompletedAt: "2026-01-01",
    hipaaFile: { fileName: "h.pdf", mimeType: "application/pdf", bytes: Buffer.from("pdf") },
  });
  const saved = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: c.id } });
  const sigs = saved.signatures as Record<string, { imageKey?: string; method?: string; signedAt?: string }>;
  expect(sigs.agreement.imageKey).toBe(`onboarding/${c.id}/sig-agreement.png`);
  expect(sigs.agreement.method).toBe("draw");
  expect(typeof sigs.agreement.signedAt).toBe("string");
  expect(saved.initials).toBe("Ada L");
  const bytes = await getObject(sigs.agreement.imageKey!);
  expect(bytes?.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify the suite now fails against the new shape**

Run: `npx vitest run src/modules/recruitment/services/onboarding.test.ts`
Expected: FAIL (type/shape mismatch: `ContractSubmission.signatures` still typed `Record<string,string>`; `initials` still required).

- [ ] **Step 3: Update imports + `ContractSubmission` type**

In `src/modules/recruitment/services/onboarding.ts`, extend the imports:

```ts
import { putObject, deleteObject } from "@/platform/storage";
import { decodeSignaturePng, SignatureError } from "./signature";
import type { SignatureInput, StoredSignature } from "../contract/signatures";
```

Change the signature/initials fields of `ContractSubmission` (lines 192-196):

```ts
  // Drawn signatures keyed by block id: each agreement's id, plus "initials".
  // Which are required is driven by the frozen snapshot layout. The typed-name
  // fallback still produces a PNG, so every value is a SignatureInput.
  signatures: Record<string, SignatureInput>;
  customAnswers?: Record<string, string | string[]>;
```

Remove the `initials: string;` line from the type (line 192).

- [ ] **Step 4: Rework validation + persistence in `submitContract`**

Replace the initials/agreement validation lines (the current lines 228-234). Old:

```ts
  const initialsEnabled = layout.blocks.some(
    (b) => b.kind === "system_field" && b.systemKey === "initials" && b.enabled !== false,
  );
  if (initialsEnabled && !input.initials?.trim()) e.initials = "required";
  for (const b of layout.blocks) {
    if (b.kind === "agreement" && !input.signatures?.[b.id]?.trim()) {
      e[`sig__${b.id}`] = "required";
    }
```

New (a signature counts as present when it carries a data URL):

```ts
  const initialsEnabled = layout.blocks.some(
    (b) => b.kind === "system_field" && b.systemKey === "initials" && b.enabled !== false,
  );
  const signed = (id: string) => Boolean(input.signatures?.[id]?.dataUrl);
  if (initialsEnabled && !signed("initials")) e["sig__initials"] = "required";
  for (const b of layout.blocks) {
    if (b.kind === "agreement" && !signed(b.id)) {
      e[`sig__${b.id}`] = "required";
    }
```

Now decode + persist the signatures to blobs before the `updateMany`. Insert this block after the HIPAA `fileRef` block (after line 300, before the `let claimed;` block), tracking written keys for rollback:

```ts
  // Persist each drawn signature as a private PNG blob and build the structured
  // record stored in the signatures JSON. Every enabled agreement (+ initials) was
  // validated as signed above, so decode failures here are treated as validation
  // errors, not crashes. Written keys are rolled back if the claim below fails.
  const signatureJson: Record<string, StoredSignature> = {};
  const signatureKeys: string[] = [];
  const cleanupSignatures = async () => { for (const k of signatureKeys) await deleteObject(k); };
  const requiredIds = new Set<string>([
    ...layout.blocks.filter((b) => b.kind === "agreement").map((b) => (b as { id: string }).id),
    ...(initialsEnabled ? ["initials"] : []),
  ]);
  for (const id of requiredIds) {
    const sig = input.signatures[id];
    let bytes: Buffer;
    try {
      bytes = decodeSignaturePng(sig.dataUrl);
    } catch (err) {
      await cleanupSignatures();
      if (writtenKey) await deleteObject(writtenKey);
      if (err instanceof SignatureError) throw new ContractValidationError("Please provide a valid signature.", { [`sig__${id}`]: "invalid signature" });
      throw err;
    }
    const imageKey = `onboarding/${contract.id}/sig-${id.replace(/[^a-z0-9_]/gi, "_")}.png`;
    await putObject(imageKey, bytes, "image/png");
    signatureKeys.push(imageKey);
    signatureJson[id] = { method: sig.method === "type" ? "type" : "draw", name: sig.name.trim(), imageKey, signedAt: new Date().toISOString() };
  }
  const initialsName = input.signatures.initials?.name?.trim() ?? null;
```

Update the `updateMany` `data` block (lines 320-321) to write the structured JSON and the derived initials column:

```ts
        initials: initialsName,
        signatures: signatureJson as object,
        customAnswers: (input.customAnswers ?? {}) as object,
```

Finally, extend the two failure paths so signature blobs are cleaned up. In the `catch (err)` around the `updateMany` (line 337) and in the `claimed.count === 0` branch (line 343), add `await cleanupSignatures();` alongside the existing `if (writtenKey) await deleteObject(writtenKey);`.

- [ ] **Step 5: Add `getContractForReview` (used by the admin view in Task 12)**

Append to `onboarding.ts`:

```ts
/** Load a submitted contract for the admin signed-contract view, with the owning
 *  cycle id so the page can confirm the contract belongs to the cycle in its URL. */
export async function getContractForReview(contractId: string) {
  const contract = await prisma.onboardingContract.findUnique({
    where: { id: contractId },
    include: { acceptance: { include: { application: { select: { cycleId: true } } } } },
  });
  if (!contract) return null;
  return { contract, cycleId: contract.acceptance.application.cycleId };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:prepare && npx vitest run src/modules/recruitment/services/onboarding.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/onboarding.ts src/modules/recruitment/services/onboarding.test.ts
git commit -m "feat(recruitment): store drawn contract signatures as structured blob records"
```

---

## Task 11: Render SignaturePad in the contract + harvest it in the action

**Files:**
- Modify: `src/app/onboard/[token]/contract-field.tsx:1-6,44-53,116-131`
- Modify: `src/app/onboard/[token]/actions.ts`

> **Verification note:** client + action wiring; verified end-to-end in Task 13. Here: typecheck + build.

- [ ] **Step 1: Render agreements as a SignaturePad**

In `src/app/onboard/[token]/contract-field.tsx`, import the pad:

```tsx
import { SignaturePad } from "@/platform/ui/signature-pad";
```

Replace the `block.kind === "agreement"` return (lines 44-53) so the typed `<Input name="sig__...">` becomes a pad:

```tsx
  if (block.kind === "agreement") {
    return (
      <div className="space-y-2">
        {block.body.trim() && (
          <>
            <p className="text-sm font-medium text-foreground">{block.title}</p>
            <p className="whitespace-pre-line text-sm text-foreground-soft">{renderVars(block.body, ctx)}</p>
          </>
        )}
        <SignaturePad
          name={`sig__${block.id}`}
          label={block.title}
          required
          personName={`${prefill.firstName} ${prefill.lastName}`.trim()}
          error={err(`sig__${block.id}`)}
        />
      </div>
    );
  }
```

- [ ] **Step 2: Render the `initials` system field as a SignaturePad**

In the system-field default branch, the `initials` key currently renders a text `<Input name="initials">`. Special-case it before the generic `nameByKey` return (inside the `case "date": case "email": ... default:` block, right after the `if (block.systemKey === "name")` block):

```tsx
      if (block.systemKey === "initials") {
        return (
          <SignaturePad
            name="sig__initials"
            label={label}
            required
            personName={`${prefill.firstName} ${prefill.lastName}`.trim()}
            error={err("sig__initials")}
          />
        );
      }
```

Because the initials pad now submits under `sig__initials` (not `initials`), remove `initials` from the `nameByKey` map and drop it from the `required` computation in the same branch:

```tsx
      const nameByKey: Record<string, string> = { email: "email", netId: "netId", phone: "phone", dob: "dateOfBirth", dietary: "dietaryRestrictions", yaleAffiliation: "yaleAffiliation", gradYear: "gradYear" };
      const type = spec.render === "text" ? "text" : spec.render;
      const defaults: Record<string, string> = { email: prefill.email, netId: prefill.netId, phone: prefill.phone };
      const required = block.systemKey === "email";
```

- [ ] **Step 3: Harvest signatures in the action**

In `src/app/onboard/[token]/actions.ts`, replace the manual `sig__`/`initials` harvesting with `collectSignatureInputs`, and drop the now-removed `initials` field from the input. Add the import:

```ts
import { collectSignatureInputs } from "@/modules/recruitment/contract/signatures";
```

Replace the harvest loop (the `for (const [k, v] of formData.entries())` block) so only custom answers are collected there, and build signatures separately:

```ts
  const customAnswers: Record<string, string | string[]> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("custom__")) {
      const key = k.slice(8);
      const val = String(v);
      if (key in customAnswers) customAnswers[key] = [...[customAnswers[key]].flat(), val];
      else customAnswers[key] = val;
    }
  }
  // Signatures (agreements + initials) arrive as sig__<id> data URLs with __method
  // / __name companions; group them by block id. FormData values can be File for
  // the HIPAA input, so coerce to string first.
  const signatures = collectSignatureInputs(
    [...formData.entries()].filter(([, v]) => typeof v === "string") as [string, string][],
  );
```

Remove `initials: str("initials"),` from the `ContractSubmission` object and replace `signatures,` remains as-is (it now refers to the grouped `Record<string, SignatureInput>`). The final input object no longer has an `initials` key.

- [ ] **Step 4: Verify typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: compiles. If `onboard-form.tsx` (the parent) references `initials`, it does not; it only maps blocks to `ContractField`.

- [ ] **Step 5: Commit**

```bash
git add src/app/onboard/\[token\]/contract-field.tsx src/app/onboard/\[token\]/actions.ts
git commit -m "feat(recruitment): draw-to-sign the onboarding contract agreements + initials"
```

---

## Task 12: Admin signed-contract view + link

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/onboarding/[contractId]/page.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx:63-99`

**Interfaces:**
- Consumes: `getContractForReview` (Task 10); `buildContractSignatureView` (Task 9); `safeParseLayout` behaviour (re-parse `templateSnapshot` via `resolveContractLayout`/`parseContractLayout`); `getObject` (`@/platform/storage`).

- [ ] **Step 1: Create the admin view page**

Create `src/app/(app)/recruitment/cycles/[id]/onboarding/[contractId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { getContractForReview } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout, type ContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { buildContractSignatureView } from "@/modules/recruitment/contract/signatures";
import { getObject } from "@/platform/storage";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { DateTime } from "@/platform/dates/display";

function safeLayout(value: unknown): ContractLayout {
  if (value == null) return DEFAULT_CONTRACT_LAYOUT;
  try { return parseContractLayout(value); } catch { return DEFAULT_CONTRACT_LAYOUT; }
}

/** Fetch a signature blob and inline it as a data URI so the private blob is never
 *  exposed via a public URL (the page is already reviewer-gated). */
async function inlineSignature(imageKey: string): Promise<string | null> {
  const bytes = await getObject(imageKey);
  return bytes ? `data:image/png;base64,${bytes.toString("base64")}` : null;
}

export default async function SignedContractPage({ params }: { params: Promise<{ id: string; contractId: string }> }) {
  const { id, contractId } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const found = await getContractForReview(contractId);
  if (!found || found.cycleId !== id) notFound();
  const { contract } = found;

  const layout = safeLayout(contract.templateSnapshot);
  const rows = buildContractSignatureView(layout, contract.signatures);
  const images = await Promise.all(
    rows.map((r) => (r.imageKey ? inlineSignature(r.imageKey) : Promise.resolve(null))),
  );

  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Onboarding", slug: "onboarding" },
          leaf: `${contract.firstName} ${contract.lastName}`,
        })}
      />
      <PageHeader
        title={`${contract.firstName} ${contract.lastName}`}
        description={`${contract.email}${contract.submittedAt ? " · signed" : ""}`}
      />

      <Card>
        <SectionHeader>Signatures</SectionHeader>
        <dl className="mt-3 space-y-4">
          {rows.map((r, i) => (
            <div key={r.blockId} className="border-b border-border-subtle pb-4 last:border-0 last:pb-0">
              <dt className="text-xs text-subtle-foreground">{r.title}</dt>
              <dd className="mt-1 text-sm text-foreground">
                {images[i] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- inline signature data URI, not a remote asset
                  <img src={images[i]!} alt={`${r.title} signature`} className="h-20 rounded border border-border-subtle bg-surface" />
                ) : r.legacyText ? (
                  <span className="font-medium">{r.legacyText}</span>
                ) : (
                  <span className="italic text-subtle-foreground">Not signed</span>
                )}
                {(r.name || r.signedAt) && (
                  <p className="mt-1 text-xs text-subtle-foreground">
                    {r.name}
                    {r.name && r.signedAt ? " · " : ""}
                    {r.signedAt ? <>signed <DateTime value={new Date(r.signedAt)} /></> : null}
                    {r.method ? ` · ${r.method === "type" ? "typed" : "drawn"}` : ""}
                  </p>
                )}
              </dd>
            </div>
          ))}
          {rows.length === 0 && <p className="text-sm text-muted-foreground">This contract has no signature blocks.</p>}
        </dl>
      </Card>
    </div>
  );
}
```

> Confirm `DateTime` accepts a `Date` (the applicant detail page passes `app.decidedAt`, a `Date`, so it does). `SectionHeader`, `Card`, `PageHeader`, and `cycleTrail` are all used by the neighbouring onboarding/applicant pages.

- [ ] **Step 2: Add a "View" link from the onboarding status table**

In `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx`, add a link for contracts that have been submitted. In the Status `<TD>` (lines 87-96), after the `on roster` span, add:

```tsx
                        {(r.contract?.status === "SUBMITTED" || r.contract?.status === "PROMOTED") && (
                          <Link className="ml-2 text-xs text-brand-fg hover:text-brand-hover" href={`/recruitment/cycles/${id}/onboarding/${r.contract.id}`}>
                            View
                          </Link>
                        )}
```

`Link` is already imported at the top of the file.

- [ ] **Step 3: Verify typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: compiles; the new route builds.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/recruitment/cycles/\[id\]/onboarding/\[contractId\]/page.tsx src/app/\(app\)/recruitment/cycles/\[id\]/onboarding/page.tsx
git commit -m "feat(recruitment): admin signed-contract view with rendered signatures"
```

---

## Task 13: End-to-end draw-and-submit test

**Files:**
- Create: `e2e/recruitment-signature.spec.ts`

**Interfaces:**
- Consumes: e2e `prisma` client + `tag()` (`./fixtures`); `applicantSessionCookie` (`./portal-cookie`); the dev-login flow used by `recruitment-onboarding.spec.ts`.

- [ ] **Step 1: Write the e2e spec**

Create `e2e/recruitment-signature.spec.ts`. It builds a minimal cycle via the UI, injects a SIGNATURE field via the e2e prisma client, applies through the portal, draws on the canvas with real mouse events, submits, and asserts the stored answer is a png blob ref:

```ts
import { expect, test } from "@playwright/test";
import { prisma, tag } from "./fixtures";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("apply: draw a signature field and submit; it persists as a png blob", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Build + publish a minimal single-department volunteer cycle.
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Signature E2E");
  const slug = `sig-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // Inject a required SIGNATURE field into the seeded identity section (key "signature").
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId }, orderBy: { order: "asc" } });
  const maxOrder = (await prisma.formField.aggregate({ where: { cycleId }, _max: { order: true } }))._max.order ?? -1;
  await prisma.formField.create({
    data: { cycleId, sectionId: section.id, key: "signature", label: "Signature", type: "SIGNATURE", required: true, order: maxOrder + 1 },
  });

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // Apply as a verified portal applicant.
  const applicantEmail = `e2e-sig-${Date.now()}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);

  const firstName = apply.locator('input[name="first_name"]');
  if (await firstName.isVisible().catch(() => false)) {
    await firstName.fill("Sig");
    await apply.fill('input[name="last_name"]', "Ner");
    await apply.fill('input[name="email"]', applicantEmail);
  }

  // Draw on the signature canvas with real pointer movement.
  const canvas = apply.locator('canvas[aria-label="Signature signature pad"]');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await apply.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await apply.mouse.down();
  await apply.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7);
  await apply.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await apply.mouse.up();
  await expect(apply.getByText("Signed")).toBeVisible();

  // Advance to review and submit.
  const submit = apply.getByRole("button", { name: "Submit application" });
  for (let i = 0; i < 8 && !(await submit.isVisible().catch(() => false)); i++) {
    await apply.getByRole("button", { name: "Continue" }).click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  // The stored answer is a png file-ref, not the raw data URL.
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { cycleId, emailLower: applicantEmail.toLowerCase() }, include: { applications: true } });
  const answers = applicant.applications[0].answers as Record<string, { mimeType?: string; storedName?: string; method?: string }>;
  expect(answers.signature.mimeType).toBe("image/png");
  expect(answers.signature.storedName).toMatch(/\.png$/);
  expect(answers.signature.method).toBe("draw");

  // Cleanup.
  await prisma.application.deleteMany({ where: { cycleId } });
  await prisma.applicant.deleteMany({ where: { cycleId } });
});
```

- [ ] **Step 2: Run the e2e (requires the dev server per `playwright.config`)**

Run: `npx playwright test e2e/recruitment-signature.spec.ts`
Expected: PASS. If the pad's `aria-label` differs, align the selector with the value the primitive renders (`${label} signature pad`).

- [ ] **Step 3: Commit**

```bash
git add e2e/recruitment-signature.spec.ts
git commit -m "test(e2e): draw a signature field and verify blob persistence"
```

---

## Task 14: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Typecheck, lint, unit tests, build**

Run: `npx tsc --noEmit && npx eslint . && npm run test:prepare && npm test && npm run build`
Expected: all green. `npm test` runs the full vitest suite (fileParallelism disabled; shares the test DB). Watch for the GitBook `schema-artifact.test.ts` (it only breaks when `MODULES[].permissions` change, which this feature does not touch) and the known `inbox.test.ts` createdAt-tie flake (unrelated).

- [ ] **Step 2: Manual smoke (optional but recommended)**

Use the `verify` skill or a local run: add a SIGNATURE field to a cycle in the builder, apply and draw, confirm the review thumbnail and the admin applicant image; then send an onboarding contract, sign each block by drawing, and confirm the new admin signed-contract view renders every signature.

- [ ] **Step 3: Commit any fixups, then open the PR** (per `finishing-a-development-branch`).

---

## Self-Review (completed during authoring)

- **Spec coverage:** SignaturePad (Task 2) · Blob storage + audit + enum-only schema change (Tasks 1,3,7,10) · application field type across all 7 registration touch points (Tasks 3,4,5,6,7,8) · contract per-block signing (Tasks 9,10,11) · display surfaces: applicant review (6), admin applicant (8), new admin contract view (12) · validation/security + server-stamped time (1,7,10) · backward-compat legacy strings (9,12) · testing (every task + 13) · dependency + migration (1,3). All spec sections map to a task.
- **Companion-key collision (the spec's fixed bug):** handled uniformly by routing initials through `sig__initials` and grouping via `collectSignatureInputs` (Task 9/11), and by stripping companions from application answers (Task 7).
- **Type consistency:** `SignatureInput`/`StoredSignature`/`ContractSignatureRow` defined once in `contract/signatures.ts` and consumed by Tasks 10 and 12; the application ref shape (`{ storedName, ..., method, name, signedAt }`) is distinct by design (served by the existing file route) and used only within Tasks 7 and 8.
