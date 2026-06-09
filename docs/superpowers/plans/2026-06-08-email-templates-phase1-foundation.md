# Email Templates — Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a custom email render engine and a DB-override-over-code-default template store, then route every existing transactional email through it so all platform emails become editable in the admin section.

**Architecture:** A dependency-free renderer (`{{var}}`, `{{{rawVar}}}`, `{{#if}}/{{else}}/{{/if}}`, auto HTML-escaped) is the single funnel for all email content. Each email type is a code `TemplateDescriptor` (variable catalog + default subject/body); a DB `EmailTemplate` row overrides it when present. A passthrough layout wrapper provides a future branding seam without changing current output. Existing Epic/compliance/recruitment senders are converted to pass a context object into `renderEmail()` instead of building HTML inline, verified byte-identical by characterization tests.

**Tech Stack:** TypeScript, Next.js App Router, Prisma + Postgres, vitest (integration tests against a real test DB via `resetDb()`), pg-boss worker (unchanged in Phase 1).

**Scope note:** This is Phase 1 of two. Phase 2 (audience engine, campaigns, scheduling, campaign UI) is a separate plan built on this foundation. Phase 1 ships independently: "every platform email is now editable in admin."

---

## Execution status (2026-06-08)

Completed: Tasks 1–9, 11, 12, 13. All 1051 tests pass; tsc + lint clean.

Two deviations from the plan as written, decided during execution:

1. **Permission name → `admin.manage_email_templates`** (not `emails.manage_templates`). The codebase enforces an invariant test (`src/platform/modules/registry.test.ts`) that every permission string is prefixed by its owning module id. Template editing lives under the `admin` module (`/admin/email`), so the permission is namespaced `admin.*`. Phase 2's campaign permission will follow the same rule (`admin.send_email_campaign`, or a new `emails` module if campaigns justify one).

2. **Task 10 (recruitment confirmation) DEFERRED.** The recruitment submission service (`submitApplication`) lives on the unmerged `plan-10/recruitment-foundation` branch, not on `main` (this Phase 1 branch is based on `main`). Converting it here would require merging plan-10 into this branch, entangling it with another agent's in-flight work and risking pulling unreviewed plan-10 commits into `main` via this branch's PR. The `renderEmail` engine is generic and ready; redo Task 10 as a trivial follow-up once plan-10 merges to `main` (or let the recruitment-owning agent do the conversion on their branch).

---

## File Structure

**New — render engine (pure, no DB):**
- `src/platform/email/render/escape.ts` — shared `esc()` (extracted from the two duplicate copies)
- `src/platform/email/render/tokens.ts` — `tokenize()` + `Token` type
- `src/platform/email/render/render.ts` — `renderTemplate(source, context)`
- `src/platform/email/render/validate.ts` — `validateTemplate(source, allowedVariables)`
- `*.test.ts` siblings for each of the above

**New — template registry + override resolution:**
- `src/platform/email/templates/types.ts` — `VariableDef`, `TemplateDescriptor`, `TemplateCategory`
- `src/platform/email/templates/layout.ts` — `layoutDescriptor` (passthrough wrapper)
- `src/platform/email/templates/recruitment.ts` — `recruitmentDescriptors`
- `src/platform/email/templates/registry.ts` — `getDescriptor`, `listDescriptors`, `LAYOUT_KEY`
- `src/platform/email/templates/renderEmail.ts` — `renderEmail(key, context)`
- `*.test.ts` siblings

**New — admin service + UI:**
- `src/modules/admin/services/email-templates.ts` — load/save/reset/list overrides
- `src/modules/admin/services/email-templates.test.ts`
- `src/app/admin/email/templates/page.tsx` — list
- `src/app/admin/email/templates/[key]/page.tsx` — editor (server actions inside)
- `src/app/admin/email/templates/[key]/preview.tsx` — client live-preview component

**Modified:**
- `src/platform/email/templates/epic.ts` — replace functions with `epicDescriptors`
- `src/platform/email/templates/compliance.ts` — replace functions with `complianceDescriptors`
- `src/modules/volunteers/services/epic.ts` — call `renderEmail` (caller of epic templates)
- `src/platform/email/reminders.ts` — call `renderEmail` (caller of compliance templates)
- `src/modules/recruitment/services/submissions.ts` — call `renderEmail`
- `prisma/schema.prisma` — add `EmailTemplate` model
- `src/platform/test/db.ts` — add `EmailTemplate` to the `resetDb()` TRUNCATE list
- `src/platform/modules/registry.ts` — add `emails.manage_templates` permission

> **Note for the implementer:** the exact callers of the old template functions (`epicOnboardingEmail`, etc.) are in `src/modules/volunteers/services/epic.ts` and `src/platform/email/reminders.ts`. Before deleting a function, run `git grep "complianceReminderEmail\|complianceEscalationEmail\|epicOnboardingEmail\|epicActivationEmail\|epicPasswordResetEmail\|EPIC_TEMPLATES\|COMPLIANCE_TEMPLATES"` to find every call site you must update.

---

## Task 1: Shared `esc()` HTML-escape util

**Files:**
- Create: `src/platform/email/render/escape.ts`
- Test: `src/platform/email/render/escape.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/render/escape.test.ts
import { describe, expect, it } from "vitest";
import { esc } from "./escape";

describe("esc", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(esc(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });

  it("escapes ampersand first so entities are not double-built", () => {
    expect(esc("<")).toBe("&lt;");
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  it("returns an empty string unchanged", () => {
    expect(esc("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/render/escape.test.ts`
Expected: FAIL — `Cannot find module './escape'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/platform/email/render/escape.ts
/** Escape user-supplied values before interpolating into HTML. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/render/escape.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/render/escape.ts src/platform/email/render/escape.test.ts
git commit -m "feat(email): shared HTML-escape util for render engine"
```

---

## Task 2: Tokenizer

**Files:**
- Create: `src/platform/email/render/tokens.ts`
- Test: `src/platform/email/render/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/render/tokens.test.ts
import { describe, expect, it } from "vitest";
import { tokenize } from "./tokens";

describe("tokenize", () => {
  it("splits literal text and a variable", () => {
    expect(tokenize("Hi {{ name }}!")).toEqual([
      { type: "text", value: "Hi " },
      { type: "var", name: "name" },
      { type: "text", value: "!" },
    ]);
  });

  it("recognizes raw (triple-brace) variables", () => {
    expect(tokenize("{{{ body }}}")).toEqual([{ type: "rawVar", name: "body" }]);
  });

  it("recognizes if/else/close control tags", () => {
    expect(tokenize("{{#if x}}a{{else}}b{{/if}}")).toEqual([
      { type: "ifOpen", name: "x" },
      { type: "text", value: "a" },
      { type: "else" },
      { type: "text", value: "b" },
      { type: "ifClose" },
    ]);
  });

  it("trims whitespace inside tags", () => {
    expect(tokenize("{{   name   }}")).toEqual([{ type: "var", name: "name" }]);
  });

  it("returns a single text token when there are no tags", () => {
    expect(tokenize("plain")).toEqual([{ type: "text", value: "plain" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/render/tokens.test.ts`
Expected: FAIL — `Cannot find module './tokens'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/platform/email/render/tokens.ts
export type Token =
  | { type: "text"; value: string }
  | { type: "var"; name: string }
  | { type: "rawVar"; name: string }
  | { type: "ifOpen"; name: string }
  | { type: "else" }
  | { type: "ifClose" };

// Triple-brace (raw) alternative is listed first so it wins over double-brace.
const TAG = /\{\{\{\s*(.*?)\s*\}\}\}|\{\{\s*(.*?)\s*\}\}/g;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;

  for (const m of source.matchAll(TAG)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ type: "text", value: source.slice(last, idx) });

    if (m[1] !== undefined) {
      tokens.push({ type: "rawVar", name: m[1].trim() });
    } else {
      const inner = (m[2] ?? "").trim();
      if (inner.startsWith("#if ")) {
        tokens.push({ type: "ifOpen", name: inner.slice(4).trim() });
      } else if (inner === "else") {
        tokens.push({ type: "else" });
      } else if (inner === "/if") {
        tokens.push({ type: "ifClose" });
      } else {
        tokens.push({ type: "var", name: inner });
      }
    }
    last = idx + m[0].length;
  }

  if (last < source.length) tokens.push({ type: "text", value: source.slice(last) });
  return tokens;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/render/tokens.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/render/tokens.ts src/platform/email/render/tokens.test.ts
git commit -m "feat(email): template tokenizer"
```

---

## Task 3: `renderTemplate`

**Files:**
- Create: `src/platform/email/render/render.ts`
- Test: `src/platform/email/render/render.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/render/render.test.ts
import { describe, expect, it } from "vitest";
import { renderTemplate } from "./render";

describe("renderTemplate", () => {
  it("substitutes and HTML-escapes variables", () => {
    expect(renderTemplate("Hi {{ name }}", { name: "<b>A&B</b>" })).toBe(
      "Hi &lt;b&gt;A&amp;B&lt;/b&gt;",
    );
  });

  it("does not escape raw (triple-brace) variables", () => {
    expect(renderTemplate("{{{ body }}}", { body: "<p>hi</p>" })).toBe("<p>hi</p>");
  });

  it("renders missing variables as empty string", () => {
    expect(renderTemplate("a{{ missing }}b", {})).toBe("ab");
  });

  it("renders the consequent when the condition is truthy", () => {
    expect(renderTemplate("{{#if x}}YES{{else}}NO{{/if}}", { x: "v" })).toBe("YES");
  });

  it("renders the alternate when the condition is falsy", () => {
    expect(renderTemplate("{{#if x}}YES{{else}}NO{{/if}}", { x: "" })).toBe("NO");
  });

  it("treats empty string, 0, false, null, undefined as falsy", () => {
    const t = "{{#if x}}Y{{/if}}";
    expect(renderTemplate(t, { x: "" })).toBe("");
    expect(renderTemplate(t, { x: 0 })).toBe("");
    expect(renderTemplate(t, { x: false })).toBe("");
    expect(renderTemplate(t, { x: null })).toBe("");
    expect(renderTemplate(t, {})).toBe("");
    expect(renderTemplate(t, { x: "ok" })).toBe("Y");
  });

  it("supports nested conditionals", () => {
    const t = "{{#if a}}A{{#if b}}B{{/if}}{{/if}}";
    expect(renderTemplate(t, { a: true, b: true })).toBe("AB");
    expect(renderTemplate(t, { a: true, b: false })).toBe("A");
    expect(renderTemplate(t, { a: false, b: true })).toBe("");
  });

  it("renders an if-block with no else when truthy and falsy", () => {
    expect(renderTemplate("x{{#if a}}Y{{/if}}z", { a: true })).toBe("xYz");
    expect(renderTemplate("x{{#if a}}Y{{/if}}z", { a: false })).toBe("xz");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/render/render.test.ts`
Expected: FAIL — `Cannot find module './render'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/platform/email/render/render.ts
import { esc } from "./escape";
import { tokenize, type Token } from "./tokens";

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  return Boolean(v);
}

export function renderTemplate(source: string, context: Record<string, unknown>): string {
  const tokens = tokenize(source);
  let i = 0;

  function renderUntil(stopAtElse: boolean): string {
    let out = "";
    while (i < tokens.length) {
      const t: Token = tokens[i];
      if (t.type === "ifClose") return out; // caller consumes the close
      if (t.type === "else" && stopAtElse) return out;
      i++;

      if (t.type === "text") {
        out += t.value;
      } else if (t.type === "var") {
        const v = context[t.name];
        out += v === null || v === undefined ? "" : esc(String(v));
      } else if (t.type === "rawVar") {
        const v = context[t.name];
        out += v === null || v === undefined ? "" : String(v);
      } else if (t.type === "ifOpen") {
        const cond = truthy(context[t.name]);
        const consequent = renderUntil(true);
        let alternate = "";
        if (tokens[i]?.type === "else") {
          i++; // consume {{else}}
          alternate = renderUntil(false);
        }
        if (tokens[i]?.type === "ifClose") i++; // consume {{/if}}
        out += cond ? consequent : alternate;
      }
      // stray {{else}}/{{/if}} with no matching open are ignored
    }
    return out;
  }

  return renderUntil(false);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/render/render.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/render/render.ts src/platform/email/render/render.test.ts
git commit -m "feat(email): renderTemplate (vars, raw, conditionals)"
```

---

## Task 4: `validateTemplate`

**Files:**
- Create: `src/platform/email/render/validate.ts`
- Test: `src/platform/email/render/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/render/validate.test.ts
import { describe, expect, it } from "vitest";
import { validateTemplate } from "./validate";

describe("validateTemplate", () => {
  it("passes when all variables are in the catalog and blocks balance", () => {
    const r = validateTemplate("Hi {{name}} {{#if dept}}{{dept}}{{/if}}", ["name", "dept"]);
    expect(r.ok).toBe(true);
    expect(r.unknownVariables).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("reports unknown variables (deduped)", () => {
    const r = validateTemplate("{{a}} {{b}} {{a}}", ["a"]);
    expect(r.ok).toBe(false);
    expect(r.unknownVariables).toEqual(["b"]);
  });

  it("reports an unclosed if block", () => {
    const r = validateTemplate("{{#if a}}x", ["a"]);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("1 unclosed {{#if}} block(s)");
  });

  it("reports a stray close", () => {
    const r = validateTemplate("x{{/if}}", []);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Unexpected {{/if}} without matching {{#if}}");
  });

  it("reports an else outside an if", () => {
    const r = validateTemplate("x{{else}}y", []);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("{{else}} outside of an {{#if}} block");
  });

  it("validates raw variables against the catalog too", () => {
    const r = validateTemplate("{{{ body }}}", ["body"]);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/render/validate.test.ts`
Expected: FAIL — `Cannot find module './validate'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/platform/email/render/validate.ts
import { tokenize } from "./tokens";

export type ValidationResult = {
  ok: boolean;
  unknownVariables: string[];
  errors: string[];
};

export function validateTemplate(source: string, allowedVariables: string[]): ValidationResult {
  const allowed = new Set(allowedVariables);
  const unknown = new Set<string>();
  const errors: string[] = [];
  let depth = 0;

  for (const t of tokenize(source)) {
    if (t.type === "var" || t.type === "rawVar") {
      if (!allowed.has(t.name)) unknown.add(t.name);
    } else if (t.type === "ifOpen") {
      if (!allowed.has(t.name)) unknown.add(t.name);
      depth++;
    } else if (t.type === "ifClose") {
      if (depth === 0) errors.push("Unexpected {{/if}} without matching {{#if}}");
      else depth--;
    } else if (t.type === "else") {
      if (depth === 0) errors.push("{{else}} outside of an {{#if}} block");
    }
  }

  if (depth > 0) errors.push(`${depth} unclosed {{#if}} block(s)`);

  const unknownVariables = [...unknown];
  return { ok: unknownVariables.length === 0 && errors.length === 0, unknownVariables, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/render/validate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/render/validate.ts src/platform/email/render/validate.test.ts
git commit -m "feat(email): validateTemplate against variable catalog"
```

---

## Task 5: Descriptor types, layout descriptor, registry

**Files:**
- Create: `src/platform/email/templates/types.ts`
- Create: `src/platform/email/templates/layout.ts`
- Create: `src/platform/email/templates/registry.ts`
- Test: `src/platform/email/templates/registry.test.ts`

> Epic/compliance/recruitment descriptor modules are added in Tasks 8–10. For now the registry imports only the layout descriptor; later tasks extend the `ALL` array.

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/templates/registry.test.ts
import { describe, expect, it } from "vitest";
import { getDescriptor, listDescriptors, LAYOUT_KEY } from "./registry";

describe("template registry", () => {
  it("exposes the layout descriptor with a {{{ body }}} placeholder", () => {
    const layout = getDescriptor(LAYOUT_KEY);
    expect(layout).toBeDefined();
    expect(layout?.category).toBe("layout");
    expect(layout?.defaultBody).toContain("{{{ body }}}");
  });

  it("returns undefined for an unknown key", () => {
    expect(getDescriptor("does-not-exist")).toBeUndefined();
  });

  it("lists descriptors with unique keys", () => {
    const keys = listDescriptors().map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/templates/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/platform/email/templates/types.ts
export type VariableDef = { name: string; label: string; sampleValue: string };
export type TemplateCategory = "transactional" | "layout" | "campaign";

export type TemplateDescriptor = {
  key: string;
  name: string;
  category: TemplateCategory;
  variables: VariableDef[];
  defaultSubject: string;
  defaultBody: string;
};
```

```typescript
// src/platform/email/templates/layout.ts
import type { TemplateDescriptor } from "./types";

// Passthrough by default: Phase 1 changes no existing email output.
// Admins can later edit this to add a HAVEN header/footer around {{{ body }}}.
export const layoutDescriptor: TemplateDescriptor = {
  key: "layout",
  name: "Shared layout wrapper",
  category: "layout",
  variables: [
    { name: "body", label: "Rendered email body (HTML)", sampleValue: "<p>Body goes here.</p>" },
    { name: "subject", label: "Email subject", sampleValue: "Subject line" },
  ],
  defaultSubject: "{{ subject }}",
  defaultBody: "{{{ body }}}",
};
```

```typescript
// src/platform/email/templates/registry.ts
import type { TemplateDescriptor } from "./types";
import { layoutDescriptor } from "./layout";

export const LAYOUT_KEY = "layout";

// Extended by Tasks 8–10 (compliance, epic, recruitment descriptors).
const ALL: TemplateDescriptor[] = [layoutDescriptor];

const BY_KEY = new Map(ALL.map((d) => [d.key, d]));

export function getDescriptor(key: string): TemplateDescriptor | undefined {
  return BY_KEY.get(key);
}

export function listDescriptors(): TemplateDescriptor[] {
  return ALL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/templates/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/templates/types.ts src/platform/email/templates/layout.ts src/platform/email/templates/registry.ts src/platform/email/templates/registry.test.ts
git commit -m "feat(email): template descriptor types, layout, registry"
```

---

## Task 6: `EmailTemplate` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (add model near `EmailLog`, around line 455)
- Modify: `src/platform/test/db.ts` (add `EmailTemplate` to the TRUNCATE list)

- [ ] **Step 1: Add the model to the schema**

Add after the `EmailLog` model in `prisma/schema.prisma`:

```prisma
/// Admin override of a code-default email template, keyed by descriptor key (e.g. "layout", "compliance-reminder").
model EmailTemplate {
  id          String   @id @default(cuid())
  /// Descriptor key this row overrides. Unique: at most one override per template.
  key         String   @unique
  subject     String
  body        String
  updatedById String?
  updatedBy   Person?  @relation("emailTemplateUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

Then add the back-relation to the `Person` model (alongside its other relations, e.g. near the `emailLogsTriggered` relation):

```prisma
  emailTemplatesUpdated EmailTemplate[] @relation("emailTemplateUpdatedBy")
```

- [ ] **Step 2: Create and apply the migration**

Ensure the dev DB is up first: `npm run db:up`
Run: `npx prisma migrate dev --name add_email_template`
Expected: a new folder under `prisma/migrations/`, and `prisma generate` runs automatically. `EmailTemplate` is now on the Prisma client.

- [ ] **Step 3: Prepare the test database**

Run: `npm run test:prepare`
Expected: `prisma migrate deploy` applies the new migration to `havenhub_test` (no error; "No pending migrations" or the new migration listed).

- [ ] **Step 4: Add `EmailTemplate` to `resetDb()`**

In `src/platform/test/db.ts`, add `"EmailTemplate"` to the `TRUNCATE ... CASCADE` table list (place it next to `"EmailLog"`).

- [ ] **Step 5: Verify the model is usable in tests**

Create a throwaway check, run it, then delete it — or simply confirm via typecheck:
Run: `npx tsc --noEmit`
Expected: PASS — `prisma.emailTemplate` typechecks.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts
git commit -m "feat(email): EmailTemplate override model + migration"
```

---

## Task 7: `renderEmail` — override resolution + layout wrap

**Files:**
- Create: `src/platform/email/templates/renderEmail.ts`
- Test: `src/platform/email/templates/renderEmail.test.ts`

> This test is DB-backed (reads `EmailTemplate` rows). It uses `resetDb()` like `send.test.ts`. It needs a registered non-layout descriptor to test against — register a temporary test descriptor is not possible (registry is static), so the test uses the real `layout` key for the override-fallback assertions and a real transactional key once Task 8 lands. To keep Task 7 self-contained, test against the `layout` descriptor plus a small inline-source path.

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/templates/renderEmail.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";

beforeEach(resetDb);

describe("renderEmail", () => {
  it("throws on an unknown template key", async () => {
    await expect(renderEmail("nope", {})).rejects.toThrow(/Unknown email template/);
  });

  it("uses the code default when no override exists and wraps in the passthrough layout", async () => {
    // 'layout' is a real descriptor; rendering it with a body var yields the body unchanged.
    const out = await renderEmail("layout", { body: "<p>hi</p>", subject: "S" });
    expect(out.subject).toBe("S");
    expect(out.html).toBe("<p>hi</p>");
  });

  it("prefers a DB override over the code default", async () => {
    await prisma.emailTemplate.create({
      data: { key: "layout", subject: "OVR {{ subject }}", body: "<x>{{{ body }}}</x>" },
    });
    const out = await renderEmail("layout", { body: "B", subject: "S" });
    expect(out.subject).toBe("OVR S");
    expect(out.html).toBe("<x>B</x>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/templates/renderEmail.test.ts`
Expected: FAIL — `Cannot find module './renderEmail'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/platform/email/templates/renderEmail.ts
import { prisma } from "@/platform/db";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor, LAYOUT_KEY } from "./registry";

export type RenderedEmail = { subject: string; html: string };

/**
 * Resolve subject + body for `key` (DB override → code default), render them with
 * `context`, then wrap the rendered body in the layout template. The layout is the
 * single seam where all emails share a wrapper.
 */
export async function renderEmail(
  key: string,
  context: Record<string, unknown>,
): Promise<RenderedEmail> {
  const descriptor = getDescriptor(key);
  if (!descriptor) throw new Error(`Unknown email template: ${key}`);

  const layout = getDescriptor(LAYOUT_KEY);
  if (!layout) throw new Error("Missing layout template");

  const overrides = await prisma.emailTemplate.findMany({
    where: { key: { in: [key, LAYOUT_KEY] } },
  });
  const byKey = new Map(overrides.map((o) => [o.key, o]));

  const subjectSource = byKey.get(key)?.subject ?? descriptor.defaultSubject;
  const bodySource = byKey.get(key)?.body ?? descriptor.defaultBody;

  const subject = renderTemplate(subjectSource, context);
  const renderedBody = renderTemplate(bodySource, context);

  // When rendering the layout descriptor itself, the caller's `body` is authoritative.
  const layoutContext =
    key === LAYOUT_KEY ? context : { ...context, body: renderedBody, subject };
  const layoutSource = byKey.get(LAYOUT_KEY)?.body ?? layout.defaultBody;
  const html = renderTemplate(layoutSource, layoutContext);

  return { subject, html };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/email/templates/renderEmail.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/templates/renderEmail.ts src/platform/email/templates/renderEmail.test.ts
git commit -m "feat(email): renderEmail with DB override resolution + layout wrap"
```

---

## Task 8: Convert compliance templates (worked example for the conversion pattern)

This task establishes the **conversion procedure** reused in Tasks 9–10. The goal: replace the inline template functions with descriptors, route the caller through `renderEmail`, and prove output is byte-identical with a characterization (golden-master) test against the pre-refactor function.

**Files:**
- Modify: `src/platform/email/templates/compliance.ts`
- Modify: `src/platform/email/reminders.ts` (caller)
- Modify: `src/platform/email/templates/registry.ts`
- Test: `src/platform/email/templates/compliance.test.ts`

- [ ] **Step 1: Capture current output as a golden master (failing test)**

First, read the current `complianceReminderEmail` / `complianceEscalationEmail` output for representative inputs and paste the EXACT current strings into the snapshot below. Generate them by temporarily logging, or copy from the current function source. Write the test to assert `renderEmail` reproduces them:

```typescript
// src/platform/email/templates/compliance.test.ts
import { describe, expect, it } from "vitest";
import { renderEmail } from "./renderEmail";
import { complianceReminderContext, complianceEscalationContext } from "./compliance";

// GOLDEN MASTER: paste the EXACT subject/html the current complianceReminderEmail
// returns for these inputs (capture before refactoring the function away).
const REMINDER_EXPIRED = {
  subject: "[HAVEN] HIPAA certification reminder",
  html: "<<<PASTE EXACT CURRENT HTML FOR status=EXPIRED, expiresAt=2026-01-15>>>",
};

describe("compliance templates via renderEmail (passthrough layout)", () => {
  it("compliance-reminder matches the pre-refactor output", async () => {
    const ctx = complianceReminderContext({
      personName: "Jane Doe",
      status: "EXPIRED",
      expiresAt: new Date(Date.UTC(2026, 0, 15)),
    });
    const out = await renderEmail("compliance-reminder", ctx);
    expect(out.subject).toBe(REMINDER_EXPIRED.subject);
    expect(out.html).toBe(REMINDER_EXPIRED.html);
  });
});
```

> Capture tip: before changing `compliance.ts`, run a one-off:
> `npx tsx -e "import {complianceReminderEmail} from './src/platform/email/templates/compliance.ts'; console.log(JSON.stringify(complianceReminderEmail({personName:'Jane Doe',status:'EXPIRED',expiresAt:new Date(Date.UTC(2026,0,15))})))"`
> Paste the `html` value into `REMINDER_EXPIRED.html`. Repeat for each status branch you want covered (EXPIRING_SOON, NO_CERTIFICATE, UNKNOWN_DATE) and for the escalation email.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/templates/compliance.test.ts`
Expected: FAIL — `complianceReminderContext` not exported / module shape changed.

- [ ] **Step 3: Rewrite `compliance.ts` as descriptors + context builders**

Replace the function-and-registry exports with: (a) a `*Context` builder per template that maps typed params to a flat string context (compute all derived display strings here — e.g. the status sentence and formatted date — so templates stay pure interpolation), and (b) `complianceDescriptors` whose `defaultBody` is the current HTML with `${esc(x)}` → `{{ x }}`, `${alreadySafeString}` → `{{ x }}`, and any ternary/branch → a precomputed context variable.

Pattern (apply the same transform to both compliance templates):

```typescript
// src/platform/email/templates/compliance.ts
import type { ComplianceStatus } from "...";          // keep the existing import
import type { TemplateDescriptor } from "./types";

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
function fmtDate(d: Date | null): string {
  if (d === null) return "soon";
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
// Move the existing status→sentence logic here, returning a plain string:
function statusSentence(status: ComplianceStatus, expiresAt: Date | null): string {
  // ...copy the current branch logic from complianceReminderEmail, return the sentence text...
}

export type ComplianceReminderParams = {
  personName: string;
  status: ComplianceStatus;
  expiresAt: Date | null;
};

/** Flat string context consumed by the compliance-reminder template. */
export function complianceReminderContext(p: ComplianceReminderParams): Record<string, string> {
  return {
    personName: p.personName,
    statusSentence: statusSentence(p.status, p.expiresAt),
    expiresAt: fmtDate(p.expiresAt),
  };
}

// ...complianceEscalationContext likewise...

export const complianceDescriptors: TemplateDescriptor[] = [
  {
    key: "compliance-reminder",
    name: "HIPAA compliance reminder",
    category: "transactional",
    variables: [
      { name: "personName", label: "Volunteer name", sampleValue: "Jane Doe" },
      { name: "statusSentence", label: "Status sentence", sampleValue: "Your HIPAA certification has expired." },
      { name: "expiresAt", label: "Expiry date", sampleValue: "January 15, 2026" },
    ],
    defaultSubject: "[HAVEN] HIPAA certification reminder",
    // defaultBody: the current complianceReminderEmail HTML with ${esc(personName)} -> {{ personName }}, etc.
    defaultBody: "<<<the transformed current HTML>>>",
  },
  // ...compliance-escalation descriptor...
];
```

- [ ] **Step 4: Register the descriptors**

In `registry.ts`, import and spread `complianceDescriptors` into `ALL`:

```typescript
import { complianceDescriptors } from "./compliance";
const ALL: TemplateDescriptor[] = [layoutDescriptor, ...complianceDescriptors];
```

- [ ] **Step 5: Update the caller (`reminders.ts`)**

Replace the spread of `complianceReminderEmail({...})` with `await renderEmail("compliance-reminder", complianceReminderContext({...}))`. Concretely, the current call:

```typescript
await queueEmail(prisma, {
  to: person.contactEmail,
  ...complianceReminderEmail({ personName: person.name, status, expiresAt }),
  template: "compliance-reminder",
  personId: person.id,
});
```

becomes:

```typescript
const rendered = await renderEmail(
  "compliance-reminder",
  complianceReminderContext({ personName: person.name, status, expiresAt }),
);
await queueEmail(prisma, {
  to: person.contactEmail,
  subject: rendered.subject,
  html: rendered.html,
  template: "compliance-reminder",
  personId: person.id,
});
```

Apply the same change to the escalation send site.

- [ ] **Step 6: Iterate `defaultBody` until the golden-master test passes**

Run: `npx vitest run src/platform/email/templates/compliance.test.ts`
Adjust whitespace/transform in `defaultBody` until subject + html match the pasted golden master exactly.
Expected: PASS.

- [ ] **Step 7: Verify no remaining references to the old functions**

Run: `git grep "complianceReminderEmail\|complianceEscalationEmail\|COMPLIANCE_TEMPLATES"`
Expected: no matches (all call sites migrated). Fix any stragglers.

- [ ] **Step 8: Commit**

```bash
git add src/platform/email/templates/compliance.ts src/platform/email/templates/compliance.test.ts src/platform/email/templates/registry.ts src/platform/email/reminders.ts
git commit -m "refactor(email): compliance emails via descriptors + renderEmail"
```

---

## Task 9: Convert Epic templates

Repeat the **exact** conversion procedure from Task 8 for the three Epic templates.

**Files:**
- Modify: `src/platform/email/templates/epic.ts`
- Modify: `src/modules/volunteers/services/epic.ts` (caller — confirm with `git grep EPIC_TEMPLATES`)
- Modify: `src/platform/email/templates/registry.ts`
- Test: `src/platform/email/templates/epic.test.ts`

Per-template specifics:

| Key | Subject (default) | Context variables to build in `epic*Context` |
|---|---|---|
| `epic-onboarding` | `[HAVEN] Epic {{ kindPhrase }} for {{ personName }}` | `personName`, `netId`, `contactEmail`, `epicId`, `departmentList` (pre-joined string), `kindPhrase` ("Account Request"/"Account Modification"/"Renewal"), plus booleans `isNew`/`isModify`/`isRenew` for `{{#if}}` branches, and `hasEpicId`, `hasDepartments` booleans for optional blocks |
| `epic-activation` | `[HAVEN] New Epic Account Set-up` | `personName`, `epicId`, `hasEpicId` |
| `epic-password-reset` | `[HAVEN] Epic Account Reset` | `personName`, `epicId`, `tempPassword`, `hasEpicId` |

Transform rules (identical to Task 8):
- Compute every conditional/derived string in the `*Context` builder; pass booleans for optional blocks.
- `${esc(x)}` → `{{ x }}`; already-safe interpolations → `{{ x }}`; ternaries → `{{#if flag}}…{{else}}…{{/if}}`.
- The shared `EPIC_DOWNLOAD_AND_NOTES_HTML` block is static HTML — inline it verbatim into both `epic-activation` and `epic-password-reset` `defaultBody` (it has no variables), or keep it as a const concatenated into those `defaultBody` strings.

- [ ] **Step 1:** Capture golden masters for all three templates (one input each; for onboarding cover NEW/MODIFY/RENEW), using the `npx tsx -e` capture tip from Task 8.
- [ ] **Step 2:** Write `epic.test.ts` asserting `renderEmail(key, epic*Context(params))` equals each golden master. Run; verify FAIL.
- [ ] **Step 3:** Rewrite `epic.ts` as `epicDescriptors` + `epicOnboardingContext` / `epicActivationContext` / `epicPasswordResetContext`.
- [ ] **Step 4:** Register: `import { epicDescriptors } from "./epic";` and add `...epicDescriptors` to `ALL` in `registry.ts`.
- [ ] **Step 5:** Update the caller in `src/modules/volunteers/services/epic.ts` to `await renderEmail(key, ctx)` then pass `subject`/`html` into `queueEmail` (same shape as Task 8 Step 5). The caller currently selects the function via `EPIC_TEMPLATES[template]`; replace with a `key`-and-context switch.
- [ ] **Step 6:** Iterate `defaultBody` strings until `npx vitest run src/platform/email/templates/epic.test.ts` PASSES.
- [ ] **Step 7:** `git grep "epicOnboardingEmail\|epicActivationEmail\|epicPasswordResetEmail\|EPIC_TEMPLATES"` → expect no matches.
- [ ] **Step 8:** Commit:

```bash
git add src/platform/email/templates/epic.ts src/platform/email/templates/epic.test.ts src/platform/email/templates/registry.ts src/modules/volunteers/services/epic.ts
git commit -m "refactor(email): epic emails via descriptors + renderEmail"
```

---

## Task 10: Convert the recruitment confirmation email

**Files:**
- Create: `src/platform/email/templates/recruitment.ts`
- Modify: `src/modules/recruitment/services/submissions.ts` (caller)
- Modify: `src/platform/email/templates/registry.ts`
- Test: `src/platform/email/templates/recruitment.test.ts`

Current inline content (from `submitApplication`): subject `We received your {cycleTitle} application`, body `<p>Hi {firstName},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your application and will be in touch.</p>`.

- [ ] **Step 1: Write the failing golden-master test**

```typescript
// src/platform/email/templates/recruitment.test.ts
import { describe, expect, it } from "vitest";
import { renderEmail } from "./renderEmail";
import { recruitmentReceivedContext } from "./recruitment";

describe("recruitment.application_received via renderEmail", () => {
  it("matches the pre-refactor output", async () => {
    const out = await renderEmail(
      "recruitment.application_received",
      recruitmentReceivedContext({ firstName: "Sam", cycleTitle: "Fall 2026 Volunteers" }),
    );
    expect(out.subject).toBe("We received your Fall 2026 Volunteers application");
    expect(out.html).toBe(
      "<p>Hi Sam,</p><p>Thanks for applying to HAVEN Free Clinic. We have received your application and will be in touch.</p>",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/templates/recruitment.test.ts`
Expected: FAIL — `Cannot find module './recruitment'`.

- [ ] **Step 3: Create `recruitment.ts`**

```typescript
// src/platform/email/templates/recruitment.ts
import type { TemplateDescriptor } from "./types";

export function recruitmentReceivedContext(p: {
  firstName: string;
  cycleTitle: string;
}): Record<string, string> {
  return { firstName: p.firstName, cycleTitle: p.cycleTitle };
}

export const recruitmentDescriptors: TemplateDescriptor[] = [
  {
    key: "recruitment.application_received",
    name: "Recruitment — application received",
    category: "transactional",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Recruitment cycle title", sampleValue: "Fall 2026 Volunteers" },
    ],
    defaultSubject: "We received your {{ cycleTitle }} application",
    defaultBody:
      "<p>Hi {{ firstName }},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your application and will be in touch.</p>",
  },
];
```

- [ ] **Step 4: Register the descriptor**

In `registry.ts` add `import { recruitmentDescriptors } from "./recruitment";` and `...recruitmentDescriptors` to `ALL`.

- [ ] **Step 5: Update the caller in `submissions.ts`**

`submitApplication` queues inside a `prisma.$transaction`. Render BEFORE the transaction (templates are config; rendering needs no tx), then queue inside it. Replace the inline subject/html construction with:

```typescript
const rendered = await renderEmail(
  "recruitment.application_received",
  recruitmentReceivedContext({ firstName, cycleTitle: cycle.title }),
);
```

and in the existing `queueEmail(tx, { ... })` call pass `subject: rendered.subject, html: rendered.html` (keep `to`, `template: "recruitment.application_received"`, and any `personId`/null as-is). Verify `firstName` and `cycle.title` are in scope at the render site; if `firstName` is derived from answers later, compute it before the render call.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/platform/email/templates/recruitment.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the recruitment submission suite to confirm no regression**

Run: `npx vitest run src/modules/recruitment`
Expected: PASS (the existing submission tests still pass with the new render path).

- [ ] **Step 8: Commit**

```bash
git add src/platform/email/templates/recruitment.ts src/platform/email/templates/recruitment.test.ts src/platform/email/templates/registry.ts src/modules/recruitment/services/submissions.ts
git commit -m "refactor(email): recruitment confirmation via descriptors + renderEmail"
```

---

## Task 11: Permission + template admin service

**Files:**
- Modify: `src/platform/modules/registry.ts` (add permission)
- Create: `src/modules/admin/services/email-templates.ts`
- Test: `src/modules/admin/services/email-templates.test.ts`

- [ ] **Step 1: Add the permission**

In `src/platform/modules/registry.ts`, add `"emails.manage_templates"` to the `permissions` array of the `admin` module manifest (the prefix is convention; the string just needs to exist so roles can grant it and `requirePermission` can check it).

- [ ] **Step 2: Write the failing service test**

```typescript
// src/modules/admin/services/email-templates.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  getTemplateForEdit,
  saveTemplateOverride,
  resetTemplateOverride,
  listTemplateSummaries,
  TemplateValidationError,
} from "./email-templates";

beforeEach(resetDb);

describe("email-templates service", () => {
  it("returns the code default when no override exists", async () => {
    const t = await getTemplateForEdit("recruitment.application_received");
    expect(t.hasOverride).toBe(false);
    expect(t.subject).toBe("We received your {{ cycleTitle }} application");
  });

  it("saves an override and reports it on next load", async () => {
    await saveTemplateOverride(null, "recruitment.application_received", {
      subject: "New {{ cycleTitle }}",
      body: "<p>{{ firstName }}</p>",
    });
    const t = await getTemplateForEdit("recruitment.application_received");
    expect(t.hasOverride).toBe(true);
    expect(t.subject).toBe("New {{ cycleTitle }}");
  });

  it("rejects an override referencing unknown variables", async () => {
    await expect(
      saveTemplateOverride(null, "recruitment.application_received", {
        subject: "x",
        body: "{{ bogusVar }}",
      }),
    ).rejects.toBeInstanceOf(TemplateValidationError);
  });

  it("rejects an unbalanced conditional", async () => {
    await expect(
      saveTemplateOverride(null, "recruitment.application_received", {
        subject: "x",
        body: "{{#if firstName}}hi",
      }),
    ).rejects.toBeInstanceOf(TemplateValidationError);
  });

  it("reset deletes the override and reverts to default", async () => {
    await saveTemplateOverride(null, "recruitment.application_received", {
      subject: "X",
      body: "Y",
    });
    await resetTemplateOverride(null, "recruitment.application_received");
    const t = await getTemplateForEdit("recruitment.application_received");
    expect(t.hasOverride).toBe(false);
  });

  it("lists a summary per descriptor with override flags", async () => {
    await saveTemplateOverride(null, "layout", { subject: "{{ subject }}", body: "{{{ body }}}" });
    const rows = await listTemplateSummaries();
    expect(rows.find((r) => r.key === "layout")?.hasOverride).toBe(true);
    expect(rows.find((r) => r.key === "recruitment.application_received")?.hasOverride).toBe(false);
  });

  it("throws on an unknown key", async () => {
    await expect(getTemplateForEdit("nope")).rejects.toThrow(/Unknown email template/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/modules/admin/services/email-templates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

```typescript
// src/modules/admin/services/email-templates.ts
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { getDescriptor, listDescriptors } from "@/platform/email/templates/registry";
import type { TemplateDescriptor } from "@/platform/email/templates/types";
import { validateTemplate } from "@/platform/email/render/validate";

export class TemplateValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid template: ${problems.join("; ")}`);
    this.name = "TemplateValidationError";
  }
}

function allowedVars(d: TemplateDescriptor): string[] {
  return d.variables.map((v) => v.name);
}

export type TemplateForEdit = {
  key: string;
  name: string;
  category: TemplateDescriptor["category"];
  variables: TemplateDescriptor["variables"];
  defaultSubject: string;
  defaultBody: string;
  subject: string;
  body: string;
  hasOverride: boolean;
};

export async function getTemplateForEdit(key: string): Promise<TemplateForEdit> {
  const d = getDescriptor(key);
  if (!d) throw new Error(`Unknown email template: ${key}`);
  const override = await prisma.emailTemplate.findUnique({ where: { key } });
  return {
    key: d.key,
    name: d.name,
    category: d.category,
    variables: d.variables,
    defaultSubject: d.defaultSubject,
    defaultBody: d.defaultBody,
    subject: override?.subject ?? d.defaultSubject,
    body: override?.body ?? d.defaultBody,
    hasOverride: override !== null,
  };
}

function validateOrThrow(d: TemplateDescriptor, subject: string, body: string): void {
  const allowed = allowedVars(d);
  const s = validateTemplate(subject, allowed);
  const b = validateTemplate(body, allowed);
  const problems = [
    ...s.errors,
    ...b.errors,
    ...s.unknownVariables.map((v) => `Unknown variable in subject: ${v}`),
    ...b.unknownVariables.map((v) => `Unknown variable in body: ${v}`),
  ];
  if (problems.length > 0) throw new TemplateValidationError(problems);
}

export async function saveTemplateOverride(
  actorPersonId: string | null,
  key: string,
  input: { subject: string; body: string },
): Promise<void> {
  const d = getDescriptor(key);
  if (!d) throw new Error(`Unknown email template: ${key}`);
  validateOrThrow(d, input.subject, input.body);

  const before = await prisma.emailTemplate.findUnique({ where: { key } });
  await prisma.emailTemplate.upsert({
    where: { key },
    create: { key, subject: input.subject, body: input.body, updatedById: actorPersonId },
    update: { subject: input.subject, body: input.body, updatedById: actorPersonId },
  });
  await recordAudit({
    actorPersonId,
    action: "email.template_save",
    entityType: "EmailTemplate",
    entityId: key,
    before: before ? { subject: before.subject, body: before.body } : undefined,
    after: { subject: input.subject, body: input.body },
  });
}

export async function resetTemplateOverride(
  actorPersonId: string | null,
  key: string,
): Promise<void> {
  const before = await prisma.emailTemplate.findUnique({ where: { key } });
  if (!before) return;
  await prisma.emailTemplate.delete({ where: { key } });
  await recordAudit({
    actorPersonId,
    action: "email.template_reset",
    entityType: "EmailTemplate",
    entityId: key,
    before: { subject: before.subject, body: before.body },
  });
}

export type TemplateSummary = {
  key: string;
  name: string;
  category: TemplateDescriptor["category"];
  hasOverride: boolean;
};

export async function listTemplateSummaries(): Promise<TemplateSummary[]> {
  const overrides = await prisma.emailTemplate.findMany({ select: { key: true } });
  const overridden = new Set(overrides.map((o) => o.key));
  return listDescriptors().map((d) => ({
    key: d.key,
    name: d.name,
    category: d.category,
    hasOverride: overridden.has(d.key),
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/modules/admin/services/email-templates.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/platform/modules/registry.ts src/modules/admin/services/email-templates.ts src/modules/admin/services/email-templates.test.ts
git commit -m "feat(email): template admin service + emails.manage_templates permission"
```

---

## Task 12: Templates admin UI (list + editor + live preview)

UI glue over the Task 11 service. Follows the existing `/admin/email/page.tsx` convention: server actions declared inside the page, gated by `requirePermission`. Verified manually (no DB-test for the React layer).

**Files:**
- Create: `src/app/admin/email/templates/page.tsx`
- Create: `src/app/admin/email/templates/[key]/page.tsx`
- Create: `src/app/admin/email/templates/[key]/preview.tsx`

- [ ] **Step 1: List page**

```tsx
// src/app/admin/email/templates/page.tsx
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listTemplateSummaries } from "@/modules/admin/services/email-templates";

export default async function EmailTemplatesPage() {
  await requirePermission("emails.manage_templates");
  const rows = await listTemplateSummaries();
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">Email templates</h1>
      <p className="text-sm text-gray-600">Edit the content of any platform email. Changes apply immediately.</p>
      <ul className="mt-4 divide-y">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between py-2">
            <span>
              <Link className="underline" href={`/admin/email/templates/${encodeURIComponent(r.key)}`}>
                {r.name}
              </Link>
              <span className="ml-2 text-xs text-gray-500">{r.category}</span>
            </span>
            <span className="text-xs">{r.hasOverride ? "Customized" : "Default"}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 2: Client preview component**

```tsx
// src/app/admin/email/templates/[key]/preview.tsx
"use client";
import { useMemo, useState } from "react";
import { renderTemplate } from "@/platform/email/render/render";
import type { VariableDef } from "@/platform/email/templates/types";

export function TemplateEditor(props: {
  templateKey: string;
  variables: VariableDef[];
  initialSubject: string;
  initialBody: string;
}) {
  const [subject, setSubject] = useState(props.initialSubject);
  const [body, setBody] = useState(props.initialBody);

  const sample = useMemo(() => {
    const ctx: Record<string, unknown> = {};
    for (const v of props.variables) ctx[v.name] = v.sampleValue;
    return ctx;
  }, [props.variables]);

  const previewSubject = renderTemplate(subject, sample);
  const previewHtml = renderTemplate(body, sample);

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-sm font-medium">Subject</label>
        <input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full border p-2" />
        <label className="mt-3 block text-sm font-medium">Body (HTML)</label>
        <textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={18} className="w-full border p-2 font-mono text-xs" />
        <div className="mt-2 text-xs text-gray-500">
          Variables: {props.variables.map((v) => `{{ ${v.name} }}`).join(", ")}
        </div>
      </div>
      <div>
        <div className="text-sm font-medium">Preview (sample data)</div>
        <div className="border-b py-1 text-sm"><strong>{previewSubject}</strong></div>
        <iframe title="preview" className="h-[28rem] w-full border" srcDoc={previewHtml} />
      </div>
    </div>
  );
}
```

> The `subject`/`body` inputs carry `name` attributes so they post inside the editor `<form>`. The `TemplateEditor` is nested inside the server-action form in Step 3.

- [ ] **Step 3: Editor page with save/reset server actions**

```tsx
// src/app/admin/email/templates/[key]/page.tsx
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getTemplateForEdit,
  saveTemplateOverride,
  resetTemplateOverride,
  TemplateValidationError,
} from "@/modules/admin/services/email-templates";
import { TemplateEditor } from "./preview";

type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ error?: string }> };

export default async function EditTemplatePage({ params, searchParams }: Props) {
  await requirePermission("emails.manage_templates");
  const { key } = await params;
  const { error } = await searchParams;
  const decodedKey = decodeURIComponent(key);
  const t = await getTemplateForEdit(decodedKey);

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("emails.manage_templates");
    const subject = (formData.get("subject") as string | null) ?? "";
    const body = (formData.get("body") as string | null) ?? "";
    try {
      await saveTemplateOverride(actor.personId, decodedKey, { subject, body });
    } catch (err) {
      if (err instanceof TemplateValidationError) {
        redirect(
          `/admin/email/templates/${key}?error=${encodeURIComponent(err.problems.join("; "))}`,
        );
      }
      throw err;
    }
    revalidatePath(`/admin/email/templates/${key}`);
    redirect(`/admin/email/templates/${key}`);
  }

  async function resetAction() {
    "use server";
    const actor = await requirePermission("emails.manage_templates");
    await resetTemplateOverride(actor.personId, decodedKey);
    revalidatePath(`/admin/email/templates/${key}`);
    redirect(`/admin/email/templates/${key}`);
  }

  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">{t.name}</h1>
      <p className="text-xs text-gray-500">{t.hasOverride ? "Customized" : "Using default"}</p>
      {error ? <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      <form action={saveAction} className="mt-4">
        <TemplateEditor
          templateKey={t.key}
          variables={t.variables}
          initialSubject={t.subject}
          initialBody={t.body}
        />
        <div className="mt-4 flex gap-2">
          <button type="submit" className="rounded bg-blue-600 px-4 py-2 text-white">Save</button>
        </div>
      </form>
      {t.hasOverride ? (
        <form action={resetAction} className="mt-2">
          <button type="submit" className="rounded border px-4 py-2 text-sm">Reset to default</button>
        </form>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 4: Add a link from the email dashboard**

In `src/app/admin/email/page.tsx`, add a `<Link href="/admin/email/templates">Manage templates</Link>` near the page header so the new section is reachable.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Start the app (`npm run dev`), sign in as a user holding `emails.manage_templates` (or `*`), visit `/admin/email/templates`. Verify: list shows all templates with Default/Customized flags; opening one shows the editor with a live preview that updates as you type; saving an invalid variable shows the red error; saving a valid edit flips the flag to Customized; "Reset to default" removes it. Confirm a triggered email (e.g. recruitment confirmation) reflects a saved edit.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/email/templates src/app/admin/email/page.tsx
git commit -m "feat(email): admin UI to edit email templates with live preview"
```

---

## Task 13: Full-suite verification

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (fix any new lint errors in touched files).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS — all new render/registry/renderEmail/service tests plus the unchanged existing suites (compliance reminders, recruitment submissions, `send.test.ts`).

- [ ] **Step 4: Mark plan + spec progress and commit**

Tick the boxes in this plan file, then:

```bash
git add docs/superpowers/plans/2026-06-08-email-templates-phase1-foundation.md
git commit -m "docs(email): mark phase 1 plan complete"
```

---

## Self-Review (completed during planning)

**Spec coverage:** Render engine (Tasks 1–4) ✓; code-default + DB-override resolution (Tasks 5–7) ✓; editable shared layout wrapper, passthrough default (Tasks 5, 7) ✓; convert existing transactional emails with identical output (Tasks 8–10, golden-master tests) ✓; templates admin UI with live preview + reset-to-default (Task 12) ✓; edit-in-place + audit log (Task 11 `recordAudit`) ✓; `emails.manage_templates` permission (Task 11) ✓; variable catalog drives palette + validation (Tasks 5, 11, 12) ✓. Spec items deferred to **Phase 2** (correctly out of scope here): audience engine, campaigns, scheduling/dispatch, campaign wizard UI, `emails.send_campaign`.

**Placeholder note:** Tasks 8–9 intentionally leave `defaultBody: "<<<transformed current HTML>>>"` as a deliberate, test-driven fill: the exact current HTML lives in the repo and the golden-master test (pasted from a real capture) is the precise acceptance criterion. This is the one place full bytes are not inlined because they are mechanically derived from existing source and verified by an exact-equality test — not an under-specified instruction.

**Type consistency:** `renderTemplate(source, context)`, `validateTemplate(source, allowedVariables)`, `renderEmail(key, context) → {subject, html}`, `*Context(params) → Record<string,string>`, and the service signatures (`getTemplateForEdit`/`saveTemplateOverride(actor, key, {subject,body})`/`resetTemplateOverride`/`listTemplateSummaries`) are consistent across tasks. `queueEmail` is fed `subject`/`html` from the rendered result everywhere (matching its `QueueEmailInput`).
