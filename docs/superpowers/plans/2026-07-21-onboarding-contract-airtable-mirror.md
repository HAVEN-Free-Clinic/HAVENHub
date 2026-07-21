# Onboarding Contract Airtable Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the onboarding contract at `/onboard/[token]` so it mirrors HAVEN's legacy Airtable form — real agreement prose, section headings, conditional blocks, per-department responsibility confirmations, and an Epic requirement derived from the department instead of self-reported.

**Architecture:** Three additive capabilities go into the existing contract block model (`section` blocks, `visibleWhen` conditions, `confirmKind` on agreements), reusing the application form's `FieldCondition` engine rather than inventing a second one. The default layouts then move out of `system-fields.ts` into a `contract/defaults/` module and are rebuilt on top of those capabilities. Every new block property is optional, so layouts already saved in `RecruitmentCycleContract.layout` and the `onboarding.contractTemplate` setting keep parsing unchanged.

**Tech Stack:** Next.js App Router (RSC + server actions), Prisma/Postgres, Zod, React 19, Tailwind, Vitest.

## Global Constraints

- **HAVEN Free Clinic** is two words in prose and UI; identifiers stay `havenhub`.
- **No em-dashes** in any user-facing copy, comments, or commit messages.
- **No `tailwind-merge`.** Use `cx` from `@/platform/ui/cx`.
- **No `dangerouslySetInnerHTML`** anywhere in this work. The prose renderer builds React elements.
- **No `Date.now()` or argless `new Date()` in a render body** (react-hooks/purity lint). Server-stamp dates and pass them down, as `ctx.todayIso` already does.
- Use existing UI primitives from `@/platform/ui` (`Input`, `Field`, `Select`, `Checkbox`, `Card`, `Alert`, `SignaturePad`). Do not hand-roll controls.
- Run `npm run lint` (whole repo) before any push. Typecheck and tests alone miss the eslint boundary rules.
- Test DB is throwaway Postgres on port 5434, never Neon. Per-worktree `TEST_DATABASE_URL`.
- Every new block property must be **optional** in the Zod schema so existing layouts parse.

## Blocking Dependency

**Task 13 requires `RecruitmentCycle.inPersonTrainingDate`,** added by the unmerged branch `worktree-in-person-training-date` (#352). Tasks 1 through 12, 14 and 15 do not depend on it and can proceed immediately. Before starting Task 13, confirm #352 has merged to `main` and rebase this branch onto it. **Do not add a second training-date column.**

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/recruitment/contract/prose.tsx` | **new** — markdown-subset renderer (bold, bullets, links, paragraphs) |
| `src/modules/recruitment/contract/layout.ts` | modify — `section` kind, `visibleWhen`, `confirmKind` |
| `src/modules/recruitment/contract/block-ops.ts` | modify — `addSection` op, section patching |
| `src/modules/recruitment/contract/visibility.ts` | **new** — answers map + block filtering with synthetic `department` / `track` |
| `src/modules/recruitment/contract/epic-requirement.ts` | **new** — resolve `epicNeeded` from department × track |
| `src/modules/recruitment/contract/system-fields.ts` | modify — new keys, re-export defaults |
| `src/modules/recruitment/contract/defaults/index.ts` | **new** — `defaultContractLayout(track)` assembly |
| `src/modules/recruitment/contract/defaults/shared.ts` | **new** — HIPAA, Epic preamble, data privacy prose |
| `src/modules/recruitment/contract/defaults/volunteer.ts` | **new** — volunteer layout |
| `src/modules/recruitment/contract/defaults/director.ts` | **new** — director layout |
| `src/modules/recruitment/contract/defaults/departments.ts` | **new** — 21 department responsibility blocks |
| `src/app/onboard/[token]/contract-field.tsx` | modify — section render, Epic rework, new fields |
| `src/app/onboard/[token]/onboard-form.tsx` | modify — answers map, client visibility filter |
| `src/app/onboard/[token]/actions.ts` | modify — new fields, checkbox confirms |
| `src/modules/recruitment/services/onboarding.ts` | modify — server visibility filter, Epic resolution, persistence |
| `src/modules/recruitment/services/promotion.ts` | modify — carry `pronouns` / `staffTitle` |
| `src/app/(app)/recruitment/cycles/[id]/builder/contract/section-card.tsx` | **new** — section editor card |
| `src/app/(app)/recruitment/cycles/[id]/builder/contract/condition-editor.tsx` | **new** — shared `visibleWhen` editor |
| `prisma/schema.prisma` | modify — `EpicRequirement` enum, new columns |

---

### Task 1: Markdown-subset prose renderer

The Airtable form's policy text is heavily bulleted, bolded and hyperlinked. Today `contract-field.tsx` renders agreement bodies with `whitespace-pre-line`, so bullets read as an undifferentiated wall and the HIPAA links are dead text.

**Files:**
- Create: `src/modules/recruitment/contract/prose.tsx`
- Test: `src/modules/recruitment/contract/prose.test.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: `<Prose text={string} />` — a React component rendering the supported subset. Also `parseProse(text: string): ProseNode[]` for testing, where `ProseNode = { kind: "p"; spans: Span[] } | { kind: "ul"; items: Span[][] }` and `Span = { kind: "text"; text: string } | { kind: "bold"; text: string } | { kind: "link"; text: string; href: string }`.

**Supported syntax, and nothing else:**
- Blank-line separated paragraphs
- `**bold**`
- Lines starting with `- ` become list items; consecutive items form one `<ul>`
- `[label](https://url)` links, plus bare `https://` URLs autolinked
- Links accept `http:` and `https:` only. Any other scheme renders as plain text — this is the XSS guard.

- [ ] **Step 1: Write the failing test**

```tsx
// src/modules/recruitment/contract/prose.test.tsx
import { describe, it, expect } from "vitest";
import { parseProse } from "./prose";

describe("parseProse", () => {
  it("splits blank-line separated paragraphs", () => {
    expect(parseProse("one\n\ntwo")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "one" }] },
      { kind: "p", spans: [{ kind: "text", text: "two" }] },
    ]);
  });

  it("parses bold spans", () => {
    expect(parseProse("a **b** c")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "a " },
        { kind: "bold", text: "b" },
        { kind: "text", text: " c" },
      ] },
    ]);
  });

  it("groups consecutive dash lines into one list", () => {
    expect(parseProse("- one\n- two")).toEqual([
      { kind: "ul", items: [
        [{ kind: "text", text: "one" }],
        [{ kind: "text", text: "two" }],
      ] },
    ]);
  });

  it("parses labelled links", () => {
    expect(parseProse("see [docs](https://hipaa.yale.edu)")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "see " },
        { kind: "link", text: "docs", href: "https://hipaa.yale.edu" },
      ] },
    ]);
  });

  it("autolinks bare https urls", () => {
    expect(parseProse("go to https://hipaa.yale.edu now")).toEqual([
      { kind: "p", spans: [
        { kind: "text", text: "go to " },
        { kind: "link", text: "https://hipaa.yale.edu", href: "https://hipaa.yale.edu" },
      ] },
    ]);
  });

  it("refuses non-http schemes, leaving them as text", () => {
    expect(parseProse("[x](javascript:alert(1))")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "[x](javascript:alert(1))" }] },
    ]);
  });

  it("treats html in the source as literal text", () => {
    expect(parseProse("<script>alert(1)</script>")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "<script>alert(1)</script>" }] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/prose.test.tsx`
Expected: FAIL — `Failed to resolve import "./prose"`

- [ ] **Step 3: Write the implementation**

```tsx
// src/modules/recruitment/contract/prose.tsx
import type { ReactNode } from "react";

export type Span =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

export type ProseNode =
  | { kind: "p"; spans: Span[] }
  | { kind: "ul"; items: Span[][] };

/** Only http(s) links render as anchors. Anything else stays literal text, so a
 *  javascript: or data: URL authored into an agreement body can never become a
 *  live link. This is the renderer's only security-relevant decision. */
function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

const LABELLED = /\[([^\]\n]+)\]\((\S+?)\)/;
const BARE = /https?:\/\/[^\s)]+/;
const BOLD = /\*\*([^*\n]+)\*\*/;

/** Tokenizes one line into spans. Order matters: labelled links are matched
 *  before bare URLs so the url inside [a](url) is not autolinked twice. */
function parseSpans(line: string): Span[] {
  const spans: Span[] = [];
  let rest = line;

  const push = (text: string) => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last?.kind === "text") last.text += text;
    else spans.push({ kind: "text", text });
  };

  while (rest) {
    const labelled = LABELLED.exec(rest);
    const bare = BARE.exec(rest);
    const bold = BOLD.exec(rest);

    const candidates = [
      labelled ? { at: labelled.index, m: labelled, t: "labelled" as const } : null,
      bare ? { at: bare.index, m: bare, t: "bare" as const } : null,
      bold ? { at: bold.index, m: bold, t: "bold" as const } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      push(rest);
      break;
    }
    const next = candidates.reduce((a, b) => (a.at <= b.at ? a : b));
    push(rest.slice(0, next.at));
    const matched = next.m[0];

    if (next.t === "bold") {
      spans.push({ kind: "bold", text: next.m[1] });
    } else if (next.t === "labelled") {
      const href = next.m[2];
      if (isSafeHref(href)) spans.push({ kind: "link", text: next.m[1], href });
      else push(matched);
    } else {
      if (isSafeHref(matched)) spans.push({ kind: "link", text: matched, href: matched });
      else push(matched);
    }
    rest = rest.slice(next.at + matched.length);
  }
  return spans;
}

export function parseProse(text: string): ProseNode[] {
  const nodes: ProseNode[] = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    let listItems: Span[][] = [];
    let paraLines: string[] = [];

    const flushList = () => {
      if (listItems.length) { nodes.push({ kind: "ul", items: listItems }); listItems = []; }
    };
    const flushPara = () => {
      if (paraLines.length) { nodes.push({ kind: "p", spans: parseSpans(paraLines.join(" ")) }); paraLines = []; }
    };

    for (const line of lines) {
      if (line.startsWith("- ")) { flushPara(); listItems.push(parseSpans(line.slice(2))); }
      else { flushList(); paraLines.push(line); }
    }
    flushList();
    flushPara();
  }
  return nodes;
}

function renderSpans(spans: Span[]): ReactNode[] {
  return spans.map((s, i) => {
    if (s.kind === "bold") return <strong key={i} className="font-semibold text-foreground">{s.text}</strong>;
    if (s.kind === "link") {
      return (
        <a key={i} href={s.href} target="_blank" rel="noreferrer noopener" className="text-brand underline underline-offset-2">
          {s.text}
        </a>
      );
    }
    return <span key={i}>{s.text}</span>;
  });
}

/** Renders the supported markdown subset as React elements. Never uses
 *  dangerouslySetInnerHTML, so authored HTML is inert by construction. */
export function Prose({ text, className }: { text: string; className?: string }) {
  const nodes = parseProse(text);
  if (nodes.length === 0) return null;
  return (
    <div className={className}>
      {nodes.map((n, i) =>
        n.kind === "ul" ? (
          <ul key={i} className="my-2 list-disc space-y-1 pl-5 text-sm text-foreground-soft">
            {n.items.map((item, j) => <li key={j}>{renderSpans(item)}</li>)}
          </ul>
        ) : (
          <p key={i} className="my-2 text-sm text-foreground-soft">{renderSpans(n.spans)}</p>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/contract/prose.test.tsx`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/prose.tsx src/modules/recruitment/contract/prose.test.tsx
git commit -m "feat(recruitment): add a markdown-subset prose renderer for contract bodies"
```

---

### Task 2: Section blocks, visibleWhen and confirmKind in the layout model

**Files:**
- Modify: `src/modules/recruitment/contract/layout.ts`
- Test: `src/modules/recruitment/contract/layout.test.ts`

**Interfaces:**
- Consumes: `FieldCondition` from `@/modules/recruitment/engine/field-visibility`
- Produces: `SectionBlock` type; `visibleWhen?: FieldCondition` on all four block kinds; `confirmKind?: "signature" | "initials" | "checkbox"` on `AgreementBlock`; `ContractBlock` union widened to include `SectionBlock`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/recruitment/contract/layout.test.ts`:

```ts
describe("section blocks and conditions", () => {
  it("parses a section block", () => {
    const layout = parseContractLayout({
      blocks: [{ kind: "section", id: "demographics", title: "Demographic Information", body: "**Please** complete." }],
    });
    expect(layout.blocks[0]).toEqual({
      kind: "section", id: "demographics", title: "Demographic Information", body: "**Please** complete.",
    });
  });

  it("parses visibleWhen on any block kind", () => {
    const layout = parseContractLayout({
      blocks: [{
        kind: "agreement", id: "bvhd", title: "BVHD", body: "", signatureLabel: "sign",
        confirmKind: "checkbox",
        visibleWhen: { field: "department", op: "is", value: "BVHD" },
      }],
    });
    const b = layout.blocks[0];
    expect(b.kind).toBe("agreement");
    expect(b.visibleWhen).toEqual({ field: "department", op: "is", value: "BVHD" });
  });

  it("rejects duplicate section ids", () => {
    expect(() => parseContractLayout({
      blocks: [
        { kind: "section", id: "s", title: "A", body: "" },
        { kind: "section", id: "s", title: "B", body: "" },
      ],
    })).toThrow(ContractLayoutError);
  });

  it("rejects a section id colliding with an agreement id", () => {
    expect(() => parseContractLayout({
      blocks: [
        { kind: "section", id: "x", title: "A", body: "" },
        { kind: "agreement", id: "x", title: "B", body: "", signatureLabel: "sign" },
      ],
    })).toThrow(ContractLayoutError);
  });

  it("still parses a layout with none of the new properties", () => {
    const layout = parseContractLayout({
      blocks: [{ kind: "agreement", id: "a", title: "A", body: "", signatureLabel: "sign" }],
    });
    expect(layout.blocks[0]).not.toHaveProperty("confirmKind");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/layout.test.ts`
Expected: FAIL — section blocks rejected by the discriminated union

- [ ] **Step 3: Write the implementation**

In `src/modules/recruitment/contract/layout.ts`, add the import, the new types, and the schema entries:

```ts
import type { FieldCondition } from "../engine/field-visibility";

export type ConfirmKind = "signature" | "initials" | "checkbox";

export type SectionBlock = {
  kind: "section";
  id: string;
  title: string;
  body: string;
  visibleWhen?: FieldCondition;
};
```

Add `visibleWhen?: FieldCondition;` to `SystemFieldBlock`, `AgreementBlock` and `CustomQuestionBlock`, add `confirmKind?: ConfirmKind;` to `AgreementBlock`, and widen the union:

```ts
export type ContractBlock = SystemFieldBlock | AgreementBlock | CustomQuestionBlock | SectionBlock;
```

Add the condition schema above `blockSchema`:

```ts
const conditionSchema = z.union([
  z.object({ field: z.string().min(1), op: z.literal("isAnswered") }),
  z.object({ field: z.string().min(1), op: z.enum(["is", "isNot"]), value: z.string() }),
  z.object({ field: z.string().min(1), op: z.literal("isAnyOf"), value: z.array(z.string()) }),
]);
```

Add `visibleWhen: conditionSchema.optional(),` to all three existing members of `blockSchema`, add `confirmKind: z.enum(["signature", "initials", "checkbox"]).optional(),` to the agreement member, and add a fourth member:

```ts
  z.object({
    kind: z.literal("section"),
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    visibleWhen: conditionSchema.optional(),
  }),
```

Then extend the identity check in `parseContractLayout`. Replace the existing agreement-id loop with one covering both kinds, since a section and an agreement sharing an id would collide in the builder's dnd ids:

```ts
  // Agreement and section ids share one namespace: both are addressed by id in
  // the builder's drag ids, and an agreement's id also keys stored signatures.
  const seenIds = new Set<string>();
  for (const b of layout.blocks) {
    if (b.kind !== "agreement" && b.kind !== "section") continue;
    if (seenIds.has(b.id)) problems.push(`Duplicate block id "${b.id}".`);
    seenIds.add(b.id);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/layout.test.ts`
Expected: PASS, including all pre-existing tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/layout.ts src/modules/recruitment/contract/layout.test.ts
git commit -m "feat(recruitment): add section blocks, visibleWhen and confirmKind to the contract layout"
```

---

### Task 3: Block-ops support for sections

**Files:**
- Modify: `src/modules/recruitment/contract/block-ops.ts`
- Test: `src/modules/recruitment/contract/block-ops.test.ts` (create if absent)

**Interfaces:**
- Consumes: `SectionBlock`, `ConfirmKind` from Task 2
- Produces: `{ t: "addSection" }` on `BlockOp`; `BlockPatch` widened to patch `title` / `body` / `visibleWhen` / `confirmKind`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/modules/recruitment/contract/block-ops.test.ts
describe("section ops", () => {
  it("appends a section with a unique id", () => {
    const out = applyBlockOp({ blocks: [] }, { t: "addSection" });
    expect(out.blocks[0]).toMatchObject({ kind: "section", title: "New section", body: "" });
  });

  it("gives the second section a distinct id", () => {
    let l = applyBlockOp({ blocks: [] }, { t: "addSection" });
    l = applyBlockOp(l, { t: "addSection" });
    const [a, b] = l.blocks as [{ id: string }, { id: string }];
    expect(a.id).not.toEqual(b.id);
  });

  it("patches a section body without touching its id", () => {
    const l = applyBlockOp({ blocks: [] }, { t: "addSection" });
    const id = (l.blocks[0] as { id: string }).id;
    const out = applyBlockOp(l, { t: "updateBlock", index: 0, patch: { body: "hello", id: "hacked" } as never });
    expect(out.blocks[0]).toMatchObject({ id, body: "hello" });
  });

  it("patches visibleWhen onto an agreement", () => {
    const l = applyBlockOp({ blocks: [] }, { t: "addAgreement" });
    const out = applyBlockOp(l, {
      t: "updateBlock", index: 0,
      patch: { visibleWhen: { field: "department", op: "is", value: "BVHD" } },
    });
    expect(out.blocks[0].visibleWhen).toEqual({ field: "department", op: "is", value: "BVHD" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/block-ops.test.ts`
Expected: FAIL — `addSection` is not a valid `BlockOp`

- [ ] **Step 3: Write the implementation**

In `block-ops.ts`, add `SectionBlock` to the type imports, widen `BlockPatch`, add the op, and handle it.

```ts
export type BlockPatch = Partial<Omit<SystemFieldBlock, "kind" | "systemKey">> &
  Partial<Omit<AgreementBlock, "kind" | "id">> &
  Partial<Omit<CustomQuestionBlock, "kind" | "key">> &
  Partial<Omit<SectionBlock, "kind" | "id">>;

export type BlockOp =
  | { t: "addAgreement" }
  | { t: "addSection" }
  | { t: "addCustom"; fieldType: FieldType }
  | { t: "updateBlock"; index: number; patch: BlockPatch }
  | { t: "removeBlock"; index: number }
  | { t: "reorder"; order: number[] }
  | { t: "toggleSystem"; index: number; enabled: boolean };
```

`nextAgreementId` must now consider section ids too, since Task 2 put them in one namespace. Rename and widen it:

```ts
/** Agreement and section ids share one namespace (see parseContractLayout), so
 *  a new id of either kind must avoid both. */
function nextBlockId(blocks: ContractBlock[], base: string): string {
  const existing = blocks
    .filter((b): b is AgreementBlock | SectionBlock => b.kind === "agreement" || b.kind === "section")
    .map((b) => b.id);
  return uniqueKey(base, existing);
}
```

Replace the `nextAgreementId(layout.blocks)` call in `addAgreement` with `nextBlockId(layout.blocks, "agreement")`, and add the new case:

```ts
    case "addSection": {
      const block: SectionBlock = {
        kind: "section",
        id: nextBlockId(layout.blocks, "section"),
        title: "New section",
        body: "",
      };
      return { blocks: [...layout.blocks, block] };
    }
```

In `patchBlock`, add the section branch before the final return:

```ts
  if (block.kind === "section") {
    return { ...block, ...patch, kind: "section", id: block.id } as SectionBlock;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/block-ops.ts src/modules/recruitment/contract/block-ops.test.ts
git commit -m "feat(recruitment): support section blocks in contract block ops"
```

---

### Task 4: Contract visibility resolution

**Files:**
- Create: `src/modules/recruitment/contract/visibility.ts`
- Test: `src/modules/recruitment/contract/visibility.test.ts`

**Interfaces:**
- Consumes: `isFieldVisible` from `../engine/field-visibility`; `ContractBlock` from `./layout`
- Produces:
  - `type ContractContext = { department: string | null; track: Track; epicRequirement: EpicRequirement }`
  - `buildContractAnswers(formAnswers: Record<string, string | string[]>, ctx: ContractContext): Record<string, string | string[]>`
  - `visibleContractBlocks(blocks: ContractBlock[], answers: Record<string, string | string[]>): ContractBlock[]`

`department`, `track` and `epicRequirement` are authoritative and always overwrite any same-named form answer, following the precedent in `mergeDepartmentAnswer`. `epicRequirement` is included here rather than added later because the default layouts in Tasks 9 and 11 gate the Epic self-report question on it.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/contract/visibility.ts tests
import { describe, it, expect } from "vitest";
import { buildContractAnswers, visibleContractBlocks } from "./visibility";
import type { ContractBlock } from "./layout";

const agreement = (id: string, dept: string): ContractBlock => ({
  kind: "agreement", id, title: id, body: "", signatureLabel: "sign",
  confirmKind: "checkbox", visibleWhen: { field: "department", op: "is", value: dept },
});

const director = { department: "BVHD", track: "DIRECTOR" as const, epicRequirement: "ALL" as const };
const unplaced = { department: null, track: "VOLUNTEER" as const, epicRequirement: "NONE" as const };

describe("buildContractAnswers", () => {
  it("injects department, track and epicRequirement", () => {
    expect(buildContractAnswers({}, director))
      .toEqual({ department: "BVHD", track: "DIRECTOR", epicRequirement: "ALL" });
  });

  it("lets the authoritative department win over a form answer", () => {
    expect(buildContractAnswers({ department: "WRONG" }, director).department).toBe("BVHD");
  });

  it("omits department when there is none", () => {
    expect(buildContractAnswers({}, unplaced)).toEqual({ track: "VOLUNTEER", epicRequirement: "NONE" });
  });

  it("preserves unrelated form answers", () => {
    expect(buildContractAnswers({ hasEpic: "on" }, unplaced).hasEpic).toBe("on");
  });
});

describe("visibleContractBlocks", () => {
  it("keeps only the matching department block", () => {
    const blocks = [agreement("bvhd", "BVHD"), agreement("crad", "CRAD")];
    const answers = buildContractAnswers({}, director);
    expect(visibleContractBlocks(blocks, answers).map((b) => (b as { id: string }).id)).toEqual(["bvhd"]);
  });

  it("keeps blocks with no condition", () => {
    const blocks: ContractBlock[] = [{ kind: "section", id: "s", title: "S", body: "" }];
    expect(visibleContractBlocks(blocks, {})).toHaveLength(1);
  });

  it("drops every department block when the department is unknown", () => {
    const blocks = [agreement("bvhd", "BVHD")];
    const answers = buildContractAnswers({}, unplaced);
    expect(visibleContractBlocks(blocks, answers)).toHaveLength(0);
  });

  it("shows the Epic self report only for a SOME department", () => {
    const q: ContractBlock = {
      kind: "custom_question", key: "epic_needed_self", label: "Need Epic?",
      type: "SINGLE_SELECT", required: true,
      visibleWhen: { field: "epicRequirement", op: "is", value: "SOME" },
    };
    expect(visibleContractBlocks([q], buildContractAnswers({}, director))).toHaveLength(0);
    expect(visibleContractBlocks([q], buildContractAnswers({}, { ...director, epicRequirement: "SOME" }))).toHaveLength(1);
  });
});
```

Save as `src/modules/recruitment/contract/visibility.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/visibility.test.ts`
Expected: FAIL — `Failed to resolve import "./visibility"`

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/recruitment/contract/visibility.ts
import type { EpicRequirement, Track } from "@prisma/client";
import { isFieldVisible } from "../engine/field-visibility";
import type { ContractBlock } from "./layout";

/** Facts the server knows about the person filling in the contract, which
 *  conditions may key on even though they are never asked as questions. */
export type ContractContext = {
  department: string | null;
  track: Track;
  epicRequirement: EpicRequirement;
};

/**
 * Merges the applicant's form answers with the authoritative context keys.
 * These always win: they come from the Acceptance, the cycle and the
 * department, so a stale or spoofed form field of the same name cannot change
 * which department's responsibilities a person is shown or whether they are
 * asked about Epic. `department` is omitted entirely when unknown, so
 * `op: "is"` conditions correctly match nothing rather than matching an empty
 * string.
 */
export function buildContractAnswers(
  formAnswers: Record<string, string | string[]>,
  ctx: ContractContext,
): Record<string, string | string[]> {
  return {
    ...formAnswers,
    ...(ctx.department ? { department: ctx.department } : {}),
    track: ctx.track,
    epicRequirement: ctx.epicRequirement,
  };
}

/** Filter a block list to those whose visibleWhen passes. Blocks without a
 *  condition are always kept, matching isFieldVisible's contract. */
export function visibleContractBlocks(
  blocks: ContractBlock[],
  answers: Record<string, string | string[]>,
): ContractBlock[] {
  return blocks.filter((b) => isFieldVisible(b.visibleWhen, answers));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/contract/visibility.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/visibility.ts src/modules/recruitment/contract/visibility.test.ts
git commit -m "feat(recruitment): resolve contract block visibility with authoritative department and track"
```

---

### Task 5: Schema migration for every new column

One migration covers all the new columns so there is a single `prisma migrate` cycle rather than four.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_contract_airtable_mirror/migration.sql` (generated)

**Interfaces:**
- Produces: `EpicRequirement` enum; `Person.pronouns`, `Person.staffTitle`; `OnboardingContract.pronouns`, `.staffTitle`, `.epicIdExpiration`; `Department.requiresEpicDirector`, `.requiresEpicVolunteer`, `.epicGuidance`; `RecruitmentCycle.trainingLocation`.

- [ ] **Step 1: Edit the schema**

Add the enum near the other enums at the top of `prisma/schema.prisma`:

```prisma
/// Whether a department's members need an Epic account. SOME means it depends on
/// the individual role (for example LCC Patient Navigators but not the whole
/// department), so those people are asked directly; ALL and NONE are resolved
/// silently from the department.
enum EpicRequirement {
  ALL
  NONE
  SOME
}
```

On `model Person`, beside `yaleAffiliation`:

```prisma
  pronouns                       String?
  staffTitle                     String?
```

On `model OnboardingContract`, beside `yaleAffiliation`:

```prisma
  pronouns                 String?
  staffTitle               String?
  epicIdExpiration         DateTime?
```

On `model Department`, beside `idealHeadcount`:

```prisma
  /// Epic account requirement for this department's directors and volunteers.
  /// Drives OnboardingContract.epicNeeded, which promotion.ts uses to raise the
  /// EpicRequest. Defaults are deliberately NONE so a newly created department
  /// never silently provisions Epic accounts.
  requiresEpicDirector       EpicRequirement         @default(NONE)
  requiresEpicVolunteer      EpicRequirement         @default(NONE)
  /// Shown as help text when the requirement is SOME, explaining who qualifies.
  epicGuidance               String?
```

On `model RecruitmentCycle`, beside `quizMaxAttempts`:

```prisma
  trainingLocation     String?
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name contract_airtable_mirror`
Expected: creates `prisma/migrations/<timestamp>_contract_airtable_mirror/migration.sql` and regenerates the client.

- [ ] **Step 3: Inspect the migration for drift**

Open the generated `migration.sql`. `prisma migrate dev` folds any pre-existing drift into the new migration. It must contain **only** the `CREATE TYPE "EpicRequirement"`, the `ALTER TABLE ... ADD COLUMN` statements listed above, and nothing else. Delete any unrelated statement it picked up.

- [ ] **Step 4: Verify the client typechecks**

Run: `npx tsc --noEmit`
Expected: PASS. If it fails with stale Prisma types, run `npx prisma generate` and retry.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(recruitment): add contract mirror columns and the EpicRequirement enum"
```

---

### Task 6: Epic requirement resolver

**Files:**
- Create: `src/modules/recruitment/contract/epic-requirement.ts`
- Test: `src/modules/recruitment/contract/epic-requirement.test.ts`

**Interfaces:**
- Consumes: `EpicRequirement`, `Track` from `@prisma/client`
- Produces:
  - `epicRequirementFor(dept: { requiresEpicDirector: EpicRequirement; requiresEpicVolunteer: EpicRequirement } | null, track: Track): EpicRequirement`
  - `resolveEpicNeeded(requirement: EpicRequirement, selfReported: boolean): boolean`

A null department resolves to `NONE`: no department means no basis to provision, and defaulting to true would raise EpicRequests for people whose acceptance record is incomplete.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/contract/epic-requirement.test.ts
import { describe, it, expect } from "vitest";
import { epicRequirementFor, resolveEpicNeeded } from "./epic-requirement";

const dept = { requiresEpicDirector: "ALL" as const, requiresEpicVolunteer: "SOME" as const };

describe("epicRequirementFor", () => {
  it("reads the director column for the director track", () => {
    expect(epicRequirementFor(dept, "DIRECTOR")).toBe("ALL");
  });
  it("reads the volunteer column for the volunteer track", () => {
    expect(epicRequirementFor(dept, "VOLUNTEER")).toBe("SOME");
  });
  it("treats a missing department as NONE", () => {
    expect(epicRequirementFor(null, "DIRECTOR")).toBe("NONE");
  });
});

describe("resolveEpicNeeded", () => {
  it("is true for ALL regardless of the self report", () => {
    expect(resolveEpicNeeded("ALL", false)).toBe(true);
  });
  it("is false for NONE regardless of the self report", () => {
    expect(resolveEpicNeeded("NONE", true)).toBe(false);
  });
  it("defers to the self report for SOME", () => {
    expect(resolveEpicNeeded("SOME", true)).toBe(true);
    expect(resolveEpicNeeded("SOME", false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/epic-requirement.test.ts`
Expected: FAIL — `Failed to resolve import "./epic-requirement"`

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/recruitment/contract/epic-requirement.ts
import type { EpicRequirement, Track } from "@prisma/client";

type EpicColumns = {
  requiresEpicDirector: EpicRequirement;
  requiresEpicVolunteer: EpicRequirement;
};

/** Pick the requirement column matching the cycle's track. A null department
 *  (an acceptance whose departmentCode no longer resolves) yields NONE: with no
 *  department there is no basis to provision Epic, and defaulting the other way
 *  would raise EpicRequests nobody asked for. */
export function epicRequirementFor(dept: EpicColumns | null, track: Track): EpicRequirement {
  if (!dept) return "NONE";
  return track === "DIRECTOR" ? dept.requiresEpicDirector : dept.requiresEpicVolunteer;
}

/** Collapse the requirement plus the applicant's answer into the boolean that
 *  promotion.ts reads to decide whether to create an EpicRequest. Only SOME
 *  consults the applicant; ALL and NONE are decided by the department. */
export function resolveEpicNeeded(requirement: EpicRequirement, selfReported: boolean): boolean {
  if (requirement === "ALL") return true;
  if (requirement === "NONE") return false;
  return selfReported;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/contract/epic-requirement.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/epic-requirement.ts src/modules/recruitment/contract/epic-requirement.test.ts
git commit -m "feat(recruitment): resolve the Epic requirement from department and track"
```

---

### Task 7: New system fields and select-backed affiliation / grad year

**Files:**
- Modify: `src/modules/recruitment/contract/system-fields.ts`
- Test: `src/modules/recruitment/contract/system-fields.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `SYSTEM_FIELD_KEYS` gains `"pronouns"`, `"staffTitle"`, `"epicIdExpiration"`; `SystemRenderKind` gains `"select"`; `SystemFieldSpec` gains `options?: { value: string; label: string }[]`; new export `YALE_AFFILIATION_OPTIONS` and `gradYearOptions(fromYear: number)`.

`gradYearOptions` takes the year as an argument rather than reading the clock, because a render body may not call `Date.now()` (react-hooks/purity).

- [ ] **Step 1: Write the failing test**

```ts
// append to src/modules/recruitment/contract/system-fields.test.ts
import { SYSTEM_FIELDS, SYSTEM_FIELD_KEYS, YALE_AFFILIATION_OPTIONS, gradYearOptions } from "./system-fields";

describe("new system fields", () => {
  it("registers pronouns, staffTitle and epicIdExpiration as optional fields", () => {
    for (const key of ["pronouns", "staffTitle", "epicIdExpiration"] as const) {
      expect(SYSTEM_FIELD_KEYS).toContain(key);
      expect(SYSTEM_FIELDS[key].core).toBe(false);
    }
  });

  it("renders affiliation and grad year as selects", () => {
    expect(SYSTEM_FIELDS.yaleAffiliation.render).toBe("select");
    expect(SYSTEM_FIELDS.gradYear.render).toBe("select");
  });

  it("offers the Airtable affiliation options", () => {
    expect(YALE_AFFILIATION_OPTIONS.map((o) => o.label)).toEqual([
      "College", "GSAS", "YLS", "YSM - MD or MD/PhD", "YSM - PA", "YSN", "YSPH", "Staff", "Other",
    ]);
  });

  it("builds a seven year grad window plus Other and N/A", () => {
    const opts = gradYearOptions(2026);
    expect(opts.map((o) => o.value)).toEqual([
      "2026", "2027", "2028", "2029", "2030", "2031", "2032", "other", "na",
    ]);
  });

  it("keeps every system field's columns non-empty", () => {
    for (const key of SYSTEM_FIELD_KEYS) {
      expect(SYSTEM_FIELDS[key].columns.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/system-fields.test.ts`
Expected: FAIL — `YALE_AFFILIATION_OPTIONS` is not exported

- [ ] **Step 3: Write the implementation**

In `system-fields.ts`, extend the key list and render kinds:

```ts
export const SYSTEM_FIELD_KEYS = [
  "name", "email", "netId", "phone", "dob", "dietary", "yaleAffiliation",
  "gradYear", "pronouns", "staffTitle", "epic", "epicIdExpiration", "spanish",
  "licensedRN", "hipaa", "initials",
] as const;

export type SystemRenderKind =
  | "text" | "email" | "tel" | "date" | "select" | "checkbox" | "epicBlock" | "hipaaBlock";

export type SystemFieldSpec = {
  key: (typeof SYSTEM_FIELD_KEYS)[number];
  core: boolean;
  defaultLabel: string;
  render: SystemRenderKind;
  columns: string[];
  options?: { value: string; label: string }[];
};

export const YALE_AFFILIATION_OPTIONS = [
  { value: "college", label: "College" },
  { value: "gsas", label: "GSAS" },
  { value: "yls", label: "YLS" },
  { value: "ysm_md", label: "YSM - MD or MD/PhD" },
  { value: "ysm_pa", label: "YSM - PA" },
  { value: "ysn", label: "YSN" },
  { value: "ysph", label: "YSPH" },
  { value: "staff", label: "Staff" },
  { value: "other", label: "Other" },
] as const;

/** Seven graduation years starting at `fromYear`, plus Other and N/A. The year
 *  is passed in rather than read from the clock so callers in a render body do
 *  not trip the react-hooks/purity rule; the page server-stamps it. */
export function gradYearOptions(fromYear: number): { value: string; label: string }[] {
  const years = Array.from({ length: 7 }, (_, i) => String(fromYear + i));
  return [
    ...years.map((y) => ({ value: y, label: y })),
    { value: "other", label: "Other" },
    { value: "na", label: "N/A" },
  ];
}
```

Update the two changed specs and add the three new ones inside `SYSTEM_FIELDS`:

```ts
  yaleAffiliation: { key: "yaleAffiliation", core: false, defaultLabel: "Yale affiliation", render: "select", columns: ["yaleAffiliation"], options: [...YALE_AFFILIATION_OPTIONS] },
  gradYear:        { key: "gradYear", core: false, defaultLabel: "Graduation year", render: "select", columns: ["gradYear"] },
  pronouns:        { key: "pronouns", core: false, defaultLabel: "Pronouns (optional)", render: "text", columns: ["pronouns"] },
  staffTitle:      { key: "staffTitle", core: false, defaultLabel: "If you are a staff member, please list your official employee title and office or department", render: "text", columns: ["staffTitle"] },
  epicIdExpiration:{ key: "epicIdExpiration", core: false, defaultLabel: "Epic ID expiration", render: "date", columns: ["epicIdExpiration"] },
```

`gradYear` carries no static `options` because its list depends on the current year; `contract-field.tsx` supplies them from `ctx` in Task 9.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/system-fields.ts src/modules/recruitment/contract/system-fields.test.ts
git commit -m "feat(recruitment): add pronouns, staff title and Epic expiration system fields"
```

---

### Task 8: Default content module — shared prose and layout assembly

Moves `DEFAULT_CONTRACT_LAYOUT` out of `system-fields.ts`. With 21 department blocks and the full policy prose, keeping it there would swamp a file whose job is describing system fields.

**Files:**
- Create: `src/modules/recruitment/contract/defaults/shared.ts`
- Create: `src/modules/recruitment/contract/defaults/index.ts`
- Modify: `src/modules/recruitment/contract/system-fields.ts` (remove the layout, re-export)
- Test: `src/modules/recruitment/contract/defaults/index.test.ts`

**Interfaces:**
- Consumes: `ContractLayout`, `ContractBlock` from `../layout`
- Produces: `HIPAA_INSTRUCTIONS`, `EPIC_PREAMBLE`, `DATA_PRIVACY_STATEMENT` from `shared.ts`; `defaultContractLayout(track: Track): ContractLayout` and `DEFAULT_CONTRACT_LAYOUT` from `index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/contract/defaults/index.test.ts
import { describe, it, expect } from "vitest";
import { defaultContractLayout } from "./index";
import { parseContractLayout } from "../layout";
import { assertTwoTier } from "../block-ops";
import { SYSTEM_FIELD_KEYS } from "../system-fields";

describe.each(["VOLUNTEER", "DIRECTOR"] as const)("%s default layout", (track) => {
  const layout = defaultContractLayout(track);

  it("parses as a valid layout", () => {
    expect(() => parseContractLayout(layout)).not.toThrow();
  });

  it("satisfies the two tier contract", () => {
    expect(() => assertTwoTier(layout)).not.toThrow();
  });

  it("references only real system field keys", () => {
    for (const b of layout.blocks) {
      if (b.kind === "system_field") expect(SYSTEM_FIELD_KEYS).toContain(b.systemKey);
    }
  });

  it("no longer asks about Spanish", () => {
    expect(layout.blocks.some((b) => b.kind === "system_field" && b.systemKey === "spanish")).toBe(false);
  });

  it("gives every agreement a non-empty body", () => {
    for (const b of layout.blocks) {
      if (b.kind === "agreement") expect(b.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("opens with a section block", () => {
    expect(layout.blocks[0].kind).toBe("section");
  });
});

describe("director extras", () => {
  it("carries the data privacy agreement", () => {
    const layout = defaultContractLayout("DIRECTOR");
    expect(layout.blocks.some((b) => b.kind === "agreement" && b.id === "data_privacy")).toBe(true);
  });

  it("the volunteer layout does not", () => {
    const layout = defaultContractLayout("VOLUNTEER");
    expect(layout.blocks.some((b) => b.kind === "agreement" && b.id === "data_privacy")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/defaults/`
Expected: FAIL — `Failed to resolve import "./index"`

- [ ] **Step 3: Write shared.ts**

Prose is authored in the Task 1 markdown subset. Transcribed from the Airtable form.

```ts
// src/modules/recruitment/contract/defaults/shared.ts

export const HIPAA_INSTRUCTIONS = `- **HIPAA Training Instructions:** Go to [hipaa.yale.edu/training/training-modules](https://hipaa.yale.edu/training/training-modules) to complete the "Foundational HIPAA Privacy and Security Training" course and save the certificate of completion.
- There is also an "Annual HIPAA Security Attestation and HIPAA Refresher" for anyone who completed the primary course over a year ago.
- If you are not currently a Yale student, please review and sign off on the clinician's training and upload that instead of a certificate.

Please upload your HIPAA Training certificate as a PDF called "HIPAA Certificate FirstName LastName.pdf". Do not take a picture of your results; download the file itself. Quiz results are not acceptable.

To print your certificate, log into Yale Workday and navigate from "Menu" to "Learning" to "Print Learning Certificate - Yale", then enter the date of completion. There is no need to select anything in the "Learning Content Title" field. The certificate PDF will appear in your notification pane.

**This must be valid within eight months for it to be acceptable.**`;

export const EPIC_PREAMBLE = `{{orgName}} is given access to the Epic EMR since we interface with the YNHH system. Some volunteers receive Epic access directly through {{orgName}} and others, such as clinical students, receive it through their program. This information is kept confidential and is only accessible to the current IT and Communications Director, used only for Epic account-obtaining purposes for YNHH.

Directions about Epic updates will follow in the days after you complete this form.`;

export const DATA_PRIVACY_STATEMENT = `**Introduction**

HAVEN Free Clinic is a volunteer-run free clinic that services uninsured patients living in the greater New Haven area. As volunteers, we have the privilege of serving patients who are particularly vulnerable in the health care system. In that process, we must balance the need to collect data on our patients to improve our operations with the risks associated with accessing, storing, and sharing patient data.

**Data Privacy and Safety Measures**

In order to access medical records on HAVEN's patients, every volunteer completes the Yale HIPAA training through the HIPAA privacy office before gaining access to HAVEN's platforms. By signing this form, you affirm that:

- As a volunteer, you have completed or will complete the Yale HIPAA training and annual refresher as required through Yale. Volunteers are responsible for tracking when their certification expires. Any questions may be directed to the QA/QI directors and IT director.
- As a director, you are responsible for ensuring that all your volunteers are up to date on their HIPAA training at the start of each term, regardless of whether they are new or returning.

HAVEN operates across several different platforms based on each department's workflow. By signing this form, you affirm that you will use only HIPAA-compliant platforms to discuss clinic or patient-related information.

- HIPAA-compliant platforms include Epic, Yale Secure Box, Microsoft Teams, and Yale Outlook Email.
- Non-HIPAA-compliant platforms include Yale Box, the native Google suite, any other email modality, Slack (the free base version), downloading any documents from HIPAA-compliant platforms onto personal devices, GroupMe, and text messaging.

By signing this form, you affirm that you will follow best practices when sharing patient information.

- Please limit discussion of patients to private areas. Avoid discussing patient information in hallways, elevators, and around others who are not directly associated with that patient's care. Refrain from discussing any patients with anyone outside of the clinic.
- Please access Epic in private areas on a private network. Avoid accessing Epic in public areas such as coffee shops where non-clinic personnel can view your screen or access information over a public wifi network.

By signing this form, you affirm that any projects you are involved in that require IRB approval or IRB exemption will be obtained prior to starting the project.

- As a volunteer, you must double-check whether any projects you are involved in require IRB approval or exemption. Please review the [Yale IRB policies](https://your.yale.edu/research-support/human-research/policies-procedures-guidance-and-checklists) to determine which applies.
- As a director, you are responsible for determining whether any data collected in your department requires IRB approval or exemption.

If a study requires IRB approval or exemption, directors must ensure that the study is submitted to HAVEN Data Centralization via the QA/QI Directors, that executive directors are aware of the study, and that the department director works with the executive directors and QA/QI directors to identify a faculty advisor.`;

export const HAVEN_AGREEMENT_SIGNATURE = `By signing this form, you are agreeing to all of these safety measures in order to ensure that we are keeping our patient data safe. If you are ever in doubt about the work you or others may be doing in {{orgName}}, please do not hesitate to reach out to the QA/QI directors and the IT director.

**This form must be signed every term regardless of whether you are a new or returning director or volunteer.**`;
```

- [ ] **Step 4: Write index.ts**

```ts
// src/modules/recruitment/contract/defaults/index.ts
import type { Track } from "@prisma/client";
import type { ContractLayout } from "../layout";
import { VOLUNTEER_LAYOUT } from "./volunteer";
import { DIRECTOR_LAYOUT } from "./director";

export function defaultContractLayout(track: Track): ContractLayout {
  return track === "DIRECTOR" ? DIRECTOR_LAYOUT : VOLUNTEER_LAYOUT;
}

/** Retained for the render fallback in `/onboard/[token]/page.tsx`, which has no
 *  track to hand when a snapshot fails to parse. */
export const DEFAULT_CONTRACT_LAYOUT = VOLUNTEER_LAYOUT;
```

Then in `system-fields.ts`, delete `DEFAULT_CONTRACT_LAYOUT` and `defaultContractLayout` and re-export so existing importers keep working:

```ts
export { defaultContractLayout, DEFAULT_CONTRACT_LAYOUT } from "./defaults";
```

Note: `defaults/volunteer.ts` and `defaults/director.ts` land in Tasks 9 and 10. To keep this task's tests runnable, create both files now with a minimal layout — the current `DEFAULT_CONTRACT_LAYOUT` block list from git history, with each agreement body set to a single placeholder sentence and a leading section block — then replace them wholesale in Tasks 9 and 10.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/recruitment/contract/defaults src/modules/recruitment/contract/system-fields.ts
git commit -m "refactor(recruitment): move default contract layouts into their own module"
```

---

### Task 9: Volunteer default layout

**Files:**
- Modify: `src/modules/recruitment/contract/defaults/volunteer.ts`
- Test: `src/modules/recruitment/contract/defaults/volunteer.test.ts`

**Interfaces:**
- Consumes: `HIPAA_INSTRUCTIONS`, `EPIC_PREAMBLE`, `HAVEN_AGREEMENT_SIGNATURE` from `./shared`
- Produces: `VOLUNTEER_LAYOUT: ContractLayout`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/contract/defaults/volunteer.test.ts
import { describe, it, expect } from "vitest";
import { VOLUNTEER_LAYOUT } from "./volunteer";

const ids = VOLUNTEER_LAYOUT.blocks.map((b) => ("id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key));

describe("VOLUNTEER_LAYOUT", () => {
  it("carries the Airtable section headings in order", () => {
    const sections = VOLUNTEER_LAYOUT.blocks.filter((b) => b.kind === "section").map((b) => b.title);
    expect(sections).toEqual(["Basic Information", "HIPAA Compliance", "Epic Access", "Volunteer Contract"]);
  });

  it("uses initials for the volunteer agreement and commitment", () => {
    for (const id of ["agreement", "commitment"]) {
      const b = VOLUNTEER_LAYOUT.blocks.find((x) => x.kind === "agreement" && x.id === id);
      expect(b && "confirmKind" in b && b.confirmKind).toBe("initials");
    }
  });

  it("carries a training acknowledgement interpolating the training date", () => {
    const b = VOLUNTEER_LAYOUT.blocks.find((x) => x.kind === "agreement" && x.id === "training");
    expect(b && "body" in b && b.body).toContain("{{trainingDate}}");
  });

  it("has no department-gated blocks", () => {
    expect(VOLUNTEER_LAYOUT.blocks.some((b) => b.visibleWhen?.field === "department")).toBe(false);
  });

  it("gates the Epic self report on a SOME department", () => {
    const b = VOLUNTEER_LAYOUT.blocks.find((x) => x.kind === "custom_question" && x.key === "epic_needed_self");
    expect(b?.visibleWhen).toMatchObject({ field: "epicRequirement", op: "is", value: "SOME" });
  });

  it("includes pronouns and staff title", () => {
    expect(ids).toContain("pronouns");
    expect(ids).toContain("staffTitle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/defaults/volunteer.test.ts`
Expected: FAIL — placeholder layout has none of this

- [ ] **Step 3: Write the implementation**

The layout gates the Epic self-report on the `epicRequirement` synthetic answer key that Task 4 already injects. That is cleaner than listing every SOME department code in a condition, and it keeps the rule in one place.

```ts
// src/modules/recruitment/contract/defaults/volunteer.ts
import type { ContractLayout } from "../layout";
import { HIPAA_INSTRUCTIONS, EPIC_PREAMBLE, HAVEN_AGREEMENT_SIGNATURE } from "./shared";

export const VOLUNTEER_LAYOUT: ContractLayout = {
  blocks: [
    { kind: "section", id: "sec_basic", title: "Basic Information",
      body: "Welcome to {{orgName}}, we are so excited to have you." },
    { kind: "system_field", systemKey: "name" },
    { kind: "system_field", systemKey: "email" },
    { kind: "system_field", systemKey: "netId" },
    { kind: "system_field", systemKey: "phone" },
    { kind: "system_field", systemKey: "pronouns" },
    { kind: "system_field", systemKey: "dob" },
    { kind: "system_field", systemKey: "yaleAffiliation" },
    { kind: "system_field", systemKey: "gradYear" },
    { kind: "system_field", systemKey: "staffTitle",
      visibleWhen: { field: "yaleAffiliation", op: "is", value: "staff" } },
    { kind: "system_field", systemKey: "dietary" },

    { kind: "section", id: "sec_hipaa", title: "HIPAA Compliance", body: HIPAA_INSTRUCTIONS },
    { kind: "system_field", systemKey: "hipaa" },

    { kind: "section", id: "sec_epic", title: "Epic Access", body: EPIC_PREAMBLE },
    { kind: "custom_question", key: "epic_needed_self",
      label: "Is Epic access required for your role at {{orgName}}?",
      type: "SINGLE_SELECT", required: true,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      visibleWhen: { field: "epicRequirement", op: "is", value: "SOME" } },
    { kind: "system_field", systemKey: "epic" },
    { kind: "system_field", systemKey: "epicIdExpiration",
      visibleWhen: { field: "hasEpic", op: "is", value: "on" } },
    { kind: "system_field", systemKey: "licensedRN" },

    { kind: "section", id: "sec_contract", title: "Volunteer Contract", body: "" },
    { kind: "agreement", id: "agreement", title: "Volunteer Agreement", confirmKind: "initials",
      signatureLabel: "initial below",
      body: `By submitting this contract, I agree to be a volunteer at {{orgName}} during my assigned shifts. I understand that {{orgName}} serves an uninsured patient population for which the clinic functions as their main, if not only, source of medical care. Further, I understand that my role as a volunteer is crucial and integral in providing patients with vital health care services, and I am fully committed to fulfilling my responsibilities to this population as a volunteer. If I do not fulfill my volunteer commitments, I understand that the {{orgName}} directors have the discretion to remove me from my role as a volunteer.` },
    { kind: "agreement", id: "professionalism", title: "Volunteer Attendance and Professionalism Policies",
      confirmKind: "initials", signatureLabel: "initial below",
      body: `**Attendance Policy (Strike Policy)**

Volunteers absent from clinic on their scheduled day who do not find replacements will receive a first strike. If a volunteer receives two strikes in one term, then they may not be allowed to continue volunteering in that department for the remainder of that term or the next term at the discretion of the department's directors. Volunteers who receive a strike will be notified by email from a department director with the reason and date. When a volunteer receives two strikes, they will be notified by the Executive Director and will be ineligible to volunteer at {{orgName}} for the following semester. Failure to complete any necessary trainings for the department is equivalent to two strikes and will result in the same consequences.

**Professionalism**

Volunteers may be dismissed for the current semester if they fail to complete their volunteer commitments. This includes, but is not limited to, failure to attend training and complete onboarding within stated deadlines, failure to schedule shifts, and failure to respond to Directors' communications regarding volunteer duties and expectations within reasonable time to address a patient or clinic need. HIPAA violations will be reported in accordance with HIPAA policy as well as handled internally per the discretion of the Executive Directors and Department Directors, and may result in a strike and required re-training or in dismissal.

**Dismissal**

Volunteers may be dismissed by the Executive Directors in accordance with either the Strike Policy or the Professionalism Policy.` },
    { kind: "agreement", id: "commitment", title: "Commitment to the Entirety of the Semester",
      confirmKind: "initials", signatureLabel: "initial below",
      body: `This volunteer contract is binding for the semester. Volunteers are expected to complete the minimum number of shifts required by their department. Early departure in the semester without an extenuating circumstance or written agreement prior to accepting the position will make the student ineligible to volunteer the following {{orgName}} term or semester.` },
    { kind: "agreement", id: "training", title: "Training Acknowledgement",
      confirmKind: "initials", signatureLabel: "initial below",
      body: `I acknowledge that I can attend the training on {{trainingDate}}{{trainingLocation}} or will otherwise inform my directors.` },
    { kind: "agreement", id: "haven_agreement", title: "{{orgName}} Agreement Signature",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: HAVEN_AGREEMENT_SIGNATURE },
  ],
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/defaults/volunteer.ts src/modules/recruitment/contract/defaults/volunteer.test.ts
git commit -m "feat(recruitment): rebuild the volunteer contract default from the Airtable form"
```

---

### Task 10: Department responsibility blocks

**Files:**
- Create: `src/modules/recruitment/contract/defaults/departments.ts`
- Test: `src/modules/recruitment/contract/defaults/departments.test.ts`

**Interfaces:**
- Consumes: `AgreementBlock` from `../layout`
- Produces: `DEPARTMENT_RESPONSIBILITY_BLOCKS: AgreementBlock[]`, one per department code, each `confirmKind: "checkbox"` and gated on `{ field: "department", op: "is", value: CODE }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/contract/defaults/departments.test.ts
import { describe, it, expect } from "vitest";
import { DEPARTMENT_RESPONSIBILITY_BLOCKS } from "./departments";

const CODES = [
  "BVHD", "CRAD", "EDUC", "EXEC", "FCRL", "FIND", "ITCM", "INTP", "LABR",
  "LCCN", "MDIC", "PATS", "PBRL", "PCAR", "PHAM", "QAQI", "REFF", "SOSE",
  "SRR", "SRHD", "VADM",
];

describe("DEPARTMENT_RESPONSIBILITY_BLOCKS", () => {
  it("covers every department exactly once", () => {
    const gated = DEPARTMENT_RESPONSIBILITY_BLOCKS.map((b) => b.visibleWhen?.value);
    expect(gated.sort()).toEqual([...CODES].sort());
  });

  it("confirms with a checkbox, not a signature", () => {
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) expect(b.confirmKind).toBe("checkbox");
  });

  it("gives every block a non-empty body and a unique id", () => {
    const ids = new Set<string>();
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) {
      expect(b.body.trim().length).toBeGreaterThan(0);
      expect(ids.has(b.id)).toBe(false);
      ids.add(b.id);
    }
  });

  it("states approximate hours per week in every body", () => {
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) {
      expect(b.body).toMatch(/Approximate hours per week/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/defaults/departments.test.ts`
Expected: FAIL — `Failed to resolve import "./departments"`

- [ ] **Step 3: Write the implementation**

Build the file from a compact table so the 21 entries stay readable and the gating is generated once rather than repeated:

```ts
// src/modules/recruitment/contract/defaults/departments.ts
import type { AgreementBlock } from "../layout";

/** One entry per department, transcribed from the Airtable director contract.
 *  `body` is authored in the markdown subset from contract/prose.tsx. */
type DeptSpec = { code: string; name: string; hours: string; duties: string[] };

const DEPARTMENTS: DeptSpec[] = [
  { code: "BVHD", name: "Behavioral Health", hours: "10", duties: [
    "Supervising volunteers who screen patients during clinic to determine program eligibility.",
    "Working in collaboration with a psychiatrist and a psychologist to oversee the one-on-one psychoeducation offered to enrolled patients.",
    "Training BHD volunteers on the Behavioral Health program curriculum, as well as principles of population health, quality improvement, and motivational interviewing.",
    "Meeting weekly with our faculty advisors to review clinic screening, discuss program content, troubleshoot any issues, and prepare students for future program sessions.",
    "Continuously seeking community resources for patients and expanding behavioral health offerings (substance use, smoking cessation, supporting parenting).",
  ] },
  // ... one entry per remaining code, transcribed from the Airtable screenshots
];

export const DEPARTMENT_RESPONSIBILITY_BLOCKS: AgreementBlock[] = DEPARTMENTS.map((d) => ({
  kind: "agreement",
  id: `dept_${d.code.toLowerCase()}`,
  title: `Department-Specific Responsibilities: ${d.name}`,
  confirmKind: "checkbox",
  signatureLabel: "I confirm these responsibilities",
  body: [`Approximate hours per week: ${d.hours}`, "", ...d.duties.map((x) => `- ${x}`)].join("\n"),
  visibleWhen: { field: "department", op: "is", value: d.code },
}));
```

**Transcription is the bulk of this task.** Fill `DEPARTMENTS` with all 21 entries using the responsibility text and hours from the Airtable form screenshots in the originating conversation. Verify each `code` against the database before committing:

```bash
npx tsx -e "import{prisma}from'./src/platform/db';prisma.department.findMany({select:{code:true,name:true},orderBy:{code:'asc'}}).then(r=>{console.table(r);return prisma.\$disconnect()})"
```

If a code in the list does not exist in `Department`, its block can never render. Reconcile before moving on: either correct the code or drop the entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/defaults/departments.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/defaults/departments.ts src/modules/recruitment/contract/defaults/departments.test.ts
git commit -m "feat(recruitment): add per-department director responsibility blocks"
```

---

### Task 11: Director default layout

**Files:**
- Modify: `src/modules/recruitment/contract/defaults/director.ts`
- Test: `src/modules/recruitment/contract/defaults/director.test.ts`

**Interfaces:**
- Consumes: `VOLUNTEER_LAYOUT` structure as reference, `DEPARTMENT_RESPONSIBILITY_BLOCKS` from `./departments`, `DATA_PRIVACY_STATEMENT` from `./shared`
- Produces: `DIRECTOR_LAYOUT: ContractLayout`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/contract/defaults/director.test.ts
import { describe, it, expect } from "vitest";
import { DIRECTOR_LAYOUT } from "./director";
import { DEPARTMENT_RESPONSIBILITY_BLOCKS } from "./departments";

describe("DIRECTOR_LAYOUT", () => {
  it("carries every department responsibility block", () => {
    const ids = DIRECTOR_LAYOUT.blocks.filter((b) => b.kind === "agreement").map((b) => b.id);
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) expect(ids).toContain(b.id);
  });

  it("carries board responsibilities, strike policy and data privacy", () => {
    const ids = DIRECTOR_LAYOUT.blocks.filter((b) => b.kind === "agreement").map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(["board_responsibilities", "strike_policy", "data_privacy"]));
  });

  it("places department blocks after the board responsibilities", () => {
    const boardAt = DIRECTOR_LAYOUT.blocks.findIndex((b) => b.kind === "agreement" && b.id === "board_responsibilities");
    const firstDeptAt = DIRECTOR_LAYOUT.blocks.findIndex((b) => b.kind === "agreement" && b.id.startsWith("dept_"));
    expect(firstDeptAt).toBeGreaterThan(boardAt);
  });

  it("closes with a full-name signature", () => {
    const last = DIRECTOR_LAYOUT.blocks[DIRECTOR_LAYOUT.blocks.length - 1];
    expect(last.kind).toBe("agreement");
    expect("confirmKind" in last && last.confirmKind).toBe("signature");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/contract/defaults/director.test.ts`
Expected: FAIL — placeholder layout has none of this

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/recruitment/contract/defaults/director.ts
import type { ContractLayout } from "../layout";
import { HIPAA_INSTRUCTIONS, EPIC_PREAMBLE, DATA_PRIVACY_STATEMENT, HAVEN_AGREEMENT_SIGNATURE } from "./shared";
import { DEPARTMENT_RESPONSIBILITY_BLOCKS } from "./departments";

export const DIRECTOR_LAYOUT: ContractLayout = {
  blocks: [
    { kind: "section", id: "sec_intro", title: "Director Contract",
      body: `Congratulations and welcome to {{orgName}}. We are excited to have you join our team and look forward to the impact you will make as a Director. This onboarding form ensures we have the necessary information to set up your access, maintain data privacy, and support you in your role at the clinic.

Please complete this form to confirm your participation in the {{orgName}} Board of Directors. Failure to sign and submit the contract within the required timeframe may result in disqualification from the position.

**DATA PRIVACY:** Protecting patient information is of utmost importance within {{orgName}}. Failure to submit this form will result in you being unable to continue as a volunteer for this term and removal from Microsoft Teams as necessary. Both new and returning volunteers must submit this form within 48 hours of their acceptance notification.

**EMR ACCESS (if needed):** ${EPIC_PREAMBLE}` },

    { kind: "section", id: "sec_demographics", title: "Demographic Information", body: "" },
    { kind: "system_field", systemKey: "name" },
    { kind: "system_field", systemKey: "email" },
    { kind: "system_field", systemKey: "netId" },
    { kind: "system_field", systemKey: "phone" },
    { kind: "system_field", systemKey: "pronouns" },
    { kind: "system_field", systemKey: "dob" },
    { kind: "system_field", systemKey: "yaleAffiliation" },
    { kind: "system_field", systemKey: "gradYear" },
    { kind: "system_field", systemKey: "staffTitle",
      visibleWhen: { field: "yaleAffiliation", op: "is", value: "staff" } },
    { kind: "system_field", systemKey: "dietary" },

    { kind: "section", id: "sec_contracts", title: "Director Contracts", body: "" },
    { kind: "agreement", id: "board_responsibilities", title: "Board Responsibilities",
      confirmKind: "checkbox", signatureLabel: "I confirm these responsibilities",
      body: `- Attend and actively participate in all Board meetings, which occur every 2 weeks.
- Take an active role in at least one of three subcommittees (Quality Assurance, Community Relations and Engagement, Sustainability and Development), including attending all subcommittee meetings which occur every 2 weeks.
- Participate in monthly department meetings with an ED.
- Manage a consistent and effective communication system between your department's co-directors, if applicable.
- Respond to {{orgName}} related emails and requests in a professional and timely fashion.
- Monitor and evaluate department-specific and clinic-wide performance. Develop and execute quarterly quality assurance and quality improvement goals that reflect vision and initiative for your department.
- Recruit, select, schedule, record certification of, and train volunteers for your department, if applicable.
- Engage in other Board-wide undertakings, such as strategic planning sessions and fundraisers.
- Raise a minimum of $300 for the {{orgName}} 5K which occurs every Fall. Foster and maintain lasting community partnerships to inform our work.
- Be supportive, collaborative and flexible.
- Take on other responsibilities as they arise.` },
    { kind: "agreement", id: "strike_policy", title: "Active Engagement and Attendance",
      confirmKind: "checkbox", signatureLabel: "I confirm this policy",
      body: `Directors uphold the standard of professionalism to ensure the highest quality of care to our patients, the education and training of our student volunteers, and the administration and financial stability of our operations. We expect transparent and proactive communication. While there are numerous processes and resources to support you, Directors and volunteers will be held accountable if unable to fulfill commitments.

**Strike Policy**

- 2 unexcused tardies = 1 strike
- 1 unexcused absence for clinic = 1 strike
- 2 unexcused absences to board meetings = 1 strike
- 3 unexcused absences to subcommittee meetings = 1 strike
- HIPAA violation = immediate grounds for termination at the discretion of {{orgName}} Leadership
- Disrespect towards colleagues, volunteers or patients = 1 strike
- 2 instances of untimely communication with EDs, directors or volunteers = 1 strike
- Failure to perform duties affecting clinic or department workflow = 1 strike

A tardy is defined as late to the extent that it impacts patient care or the workflow of a department.

**3 strikes are grounds for termination unless a different course of action is determined by the EDs after a meeting with the {{orgName}} Board member.**` },

    ...DEPARTMENT_RESPONSIBILITY_BLOCKS,

    { kind: "custom_question", key: "second_department",
      label: "Do you plan on volunteering with another department during your term?",
      helpText: "You can only volunteer in a second patient-facing department if you have a non-patient-facing board position.",
      type: "SINGLE_SELECT", required: true,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
    { kind: "custom_question", key: "second_department_name",
      label: "If yes, what department will you be volunteering with?",
      type: "DEPARTMENT_CHOICE", required: true,
      visibleWhen: { field: "second_department", op: "is", value: "yes" } },

    { kind: "section", id: "sec_hipaa", title: "HIPAA Training", body: HIPAA_INSTRUCTIONS },
    { kind: "system_field", systemKey: "hipaa" },

    { kind: "agreement", id: "data_privacy", title: "{{orgName}} Data Privacy Statement",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: DATA_PRIVACY_STATEMENT },
    { kind: "agreement", id: "haven_agreement", title: "{{orgName}} Agreement Signature",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: HAVEN_AGREEMENT_SIGNATURE },

    { kind: "section", id: "sec_epic", title: "Epic Access", body: EPIC_PREAMBLE },
    { kind: "custom_question", key: "epic_needed_self",
      label: "Is Epic access required for your role at {{orgName}}?",
      type: "SINGLE_SELECT", required: true,
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      visibleWhen: { field: "epicRequirement", op: "is", value: "SOME" } },
    { kind: "system_field", systemKey: "epic" },
    { kind: "system_field", systemKey: "epicIdExpiration",
      visibleWhen: { field: "hasEpic", op: "is", value: "on" } },

    { kind: "agreement", id: "training", title: "Director Training",
      confirmKind: "checkbox", signatureLabel: "I will be attending",
      body: `Director training will be in person and mandatory for everyone. I acknowledge that I can attend the director training on {{trainingDate}}{{trainingLocation}}, or will notify the EDs and SR&R as soon as possible.` },
    { kind: "agreement", id: "final_acknowledgement", title: "Board Director Acknowledgement",
      confirmKind: "signature", signatureLabel: "type your full name",
      body: `By typing your full name below, you fully acknowledge and commit to the responsibilities as a Board Director at {{orgName}}.` },
  ],
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/contract/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/defaults/director.ts src/modules/recruitment/contract/defaults/director.test.ts
git commit -m "feat(recruitment): rebuild the director contract default from the Airtable form"
```

---

### Task 12: Render sections, conditions and the reworked Epic block

**Files:**
- Modify: `src/app/onboard/[token]/contract-field.tsx`
- Modify: `src/app/onboard/[token]/onboard-form.tsx`
- Modify: `src/app/onboard/[token]/page.tsx`

**Interfaces:**
- Consumes: `Prose` (Task 1), `buildContractAnswers` / `visibleContractBlocks` (Task 4), `gradYearOptions` / `YALE_AFFILIATION_OPTIONS` (Task 7), `epicRequirementFor` (Task 6)
- Produces: `Ctx` widened to `{ firstName, orgName, todayIso, currentYear, trainingDate, trainingLocation, department, track, epicRequirement }`; `ContractField` gains `onAnswer: (name: string, value: string | string[]) => void`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/onboard/[token]/contract-field.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContractField } from "./contract-field";

const ctx = {
  firstName: "Ada", orgName: "HAVEN Free Clinic", todayIso: "2026-07-21", currentYear: 2026,
  trainingDate: "Sunday, May 3", trainingLocation: " in person",
  department: "BVHD", track: "DIRECTOR" as const, epicRequirement: "ALL" as const,
};
const prefill = { firstName: "Ada", lastName: "L", email: "", netId: "", phone: "", yaleAffiliation: "", gradYear: "" };
const noop = () => {};
const noErr = () => undefined;

describe("ContractField", () => {
  it("renders a section heading and its prose", () => {
    render(<ContractField block={{ kind: "section", id: "s", title: "Epic Access", body: "**Read** this." }}
      prefill={prefill} ctx={ctx} err={noErr} onAnswer={noop} />);
    expect(screen.getByText("Epic Access")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
  });

  it("renders a checkbox agreement instead of a signature pad", () => {
    render(<ContractField block={{ kind: "agreement", id: "d", title: "Duties", body: "- one", confirmKind: "checkbox", signatureLabel: "confirm" }}
      prefill={prefill} ctx={ctx} err={noErr} onAnswer={noop} />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByText(/draw/i)).toBeNull();
  });

  it("interpolates the training date into agreement prose", () => {
    render(<ContractField block={{ kind: "agreement", id: "t", title: "T", body: "Training is on {{trainingDate}}.", confirmKind: "checkbox", signatureLabel: "confirm" }}
      prefill={prefill} ctx={ctx} err={noErr} onAnswer={noop} />);
    expect(screen.getByText(/Training is on Sunday, May 3\./)).toBeTruthy();
  });

  it("omits the epicNeeded checkbox entirely", () => {
    const { container } = render(<ContractField block={{ kind: "system_field", systemKey: "epic" }}
      prefill={prefill} ctx={ctx} err={noErr} onAnswer={noop} />);
    expect(container.querySelector('[name="epicNeeded"]')).toBeNull();
  });

  it("hides the access type until an Epic ID is declared", () => {
    const { container } = render(<ContractField block={{ kind: "system_field", systemKey: "epic" }}
      prefill={prefill} ctx={ctx} err={noErr} onAnswer={noop} />);
    expect(container.querySelector('[name="epicAccessType"]')).toBeNull();
  });

  it("renders affiliation as a select", () => {
    const { container } = render(<ContractField block={{ kind: "system_field", systemKey: "yaleAffiliation" }}
      prefill={prefill} ctx={ctx} err={noErr} onAnswer={noop} />);
    expect(container.querySelector('select[name="yaleAffiliation"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/onboard/\[token\]/contract-field.test.tsx`
Expected: FAIL — section blocks unhandled, `onAnswer` not a prop

- [ ] **Step 3: Rework contract-field.tsx**

Widen the types and replace the plain-text body render with `Prose`:

```tsx
type Ctx = {
  firstName: string; orgName: string; todayIso: string; currentYear: number;
  trainingDate: string; trainingLocation: string;
  department: string | null; track: Track; epicRequirement: EpicRequirement;
};
type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string; yaleAffiliation: string; gradYear: string };
```

`Prefill.spanish` is dropped — the Spanish field is gone from both default layouts.

Extend `renderVars` with the two training variables:

```tsx
function renderVars(text: string, ctx: Ctx): string {
  return text
    .replace(/\{\{\s*firstName\s*\}\}/g, ctx.firstName)
    .replace(/\{\{\s*orgName\s*\}\}/g, ctx.orgName)
    .replace(/\{\{\s*trainingDate\s*\}\}/g, ctx.trainingDate)
    .replace(/\{\{\s*trainingLocation\s*\}\}/g, ctx.trainingLocation);
}
```

Add the section branch at the top of the component:

```tsx
  if (block.kind === "section") {
    return (
      <div className="space-y-1 border-t border-border pt-6 first:border-0 first:pt-0">
        <h2 className="text-lg font-semibold text-foreground">{renderVars(block.title, ctx)}</h2>
        {block.body.trim() && <Prose text={renderVars(block.body, ctx)} />}
      </div>
    );
  }
```

Replace the agreement branch so it honours `confirmKind`:

```tsx
  if (block.kind === "agreement") {
    const kind = block.confirmKind ?? "signature";
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{renderVars(block.title, ctx)}</p>
        {block.body.trim() && <Prose text={renderVars(block.body, ctx)} />}
        {kind === "checkbox" ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                name={`confirm__${block.id}`}
                required
                onChange={(e) => onAnswer(`confirm__${block.id}`, e.target.checked ? "on" : "")}
                {...errorProps(`confirm__${block.id}`)}
              />
              <span>{renderVars(block.signatureLabel, ctx)}</span>
            </label>
            {err(`confirm__${block.id}`) && (
              <p id={errorId(`confirm__${block.id}`)} className="mt-1 text-xs text-critical">{err(`confirm__${block.id}`)}</p>
            )}
          </>
        ) : (
          <SignaturePad
            name={`sig__${block.id}`}
            label={renderVars(block.title, ctx)}
            required
            personName={`${prefill.firstName} ${prefill.lastName}`.trim()}
            error={err(`sig__${block.id}`)}
          />
        )}
      </div>
    );
  }
```

Rework the Epic block. `epicNeeded` is gone; access type becomes a select and, with the expiration date, is gated on `hasEpic`:

```tsx
    case "epicBlock":
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              name="hasEpic"
              checked={hasEpic}
              onChange={(e) => { setHasEpic(e.target.checked); onAnswer("hasEpic", e.target.checked ? "on" : ""); }}
            />
            <span>I already have an Epic ID</span>
          </label>
          {hasEpic && (
            <>
              <div>
                <Field label="Existing Epic ID" hint="Enter it in capital letters." required>
                  <Input name="existingEpicId" required {...errorProps("existingEpicId")} />
                </Field>
                {err("existingEpicId") && <p id={errorId("existingEpicId")} className="mt-1 text-xs text-critical">{err("existingEpicId")}</p>}
              </div>
              <Field label="What type of access are you requesting?">
                <Select name="epicAccessType" defaultValue="">
                  <option value="">Select one</option>
                  <option value="new">I need a new account. I have never had a Yale Epic account before.</option>
                  <option value="renewal">I need a reactivation, renewal, extension or modification to my existing account.</option>
                </Select>
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="worksWithYnhh" /><span>I currently work with Yale New Haven Hospital</span>
          </label>
        </div>
      );
```

Add a `select` case for affiliation and grad year, and make the HIPAA block render `block.helpText`:

```tsx
    case "select": {
      const options = block.systemKey === "gradYear" ? gradYearOptions(ctx.currentYear) : (spec.options ?? []);
      const nameByKey: Record<string, string> = { yaleAffiliation: "yaleAffiliation", gradYear: "gradYear" };
      const inputName = nameByKey[block.systemKey];
      const defaults: Record<string, string> = { yaleAffiliation: prefill.yaleAffiliation, gradYear: prefill.gradYear };
      return (
        <div>
          <Field label={label}>
            <Select
              name={inputName}
              defaultValue={defaults[block.systemKey] ?? ""}
              onChange={(e) => onAnswer(inputName, e.target.value)}
              {...errorProps(inputName)}
            >
              <option value="">Select one</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          {err(inputName) && <p id={errorId(inputName)} className="mt-1 text-xs text-critical">{err(inputName)}</p>}
        </div>
      );
    }
```

In the `hipaaBlock` case, render the help text under the label:

```tsx
          {block.helpText && <Prose text={renderVars(block.helpText, ctx)} />}
```

Finally, extend `nameByKey` in the text case with the new fields:

```tsx
      const nameByKey: Record<string, string> = {
        email: "email", netId: "netId", phone: "phone", dob: "dateOfBirth",
        dietary: "dietaryRestrictions", pronouns: "pronouns", staffTitle: "staffTitle",
        epicIdExpiration: "epicIdExpiration",
      };
```

- [ ] **Step 4: Wire the answers map in onboard-form.tsx**

```tsx
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const onAnswer = useCallback((name: string, value: string | string[]) => {
    setAnswers((prev) => ({ ...prev, [name]: value }));
  }, []);

  const resolved = buildContractAnswers(answers, {
    department: ctx.department, track: ctx.track, epicRequirement: ctx.epicRequirement,
  });

  const enabled = layout.blocks.filter(
    (b) => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core,
  );
  const shown = visibleContractBlocks(enabled, resolved);
```

Render `shown` instead of the inline filter, keying on the block's stable identity rather than the array index so React does not reuse a removed block's DOM state:

```tsx
        {shown.map((b) => (
          <ContractField
            key={"id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key}
            block={b} prefill={prefill} ctx={ctx} err={err} onAnswer={onAnswer}
          />
        ))}
```

- [ ] **Step 5: Extend the server context in page.tsx**

`getContractByToken` must now include the acceptance so the department is available. Update its Prisma call in `services/onboarding.ts` to `include: { acceptance: { include: { application: { include: { cycle: true } } } } }`, then in `page.tsx`:

Also drop `spanish` from the `prefill` object built here, since `Prefill` no longer carries it and neither default layout renders a Spanish field:

```tsx
  const prefill = {
    firstName: contract.firstName,
    lastName: contract.lastName,
    email: contract.email,
    netId: contract.netId ?? "",
    phone: contract.phone ?? "",
    yaleAffiliation: contract.yaleAffiliation ?? "",
    gradYear: contract.gradYear ?? "",
  };
```

```tsx
  const departmentCode = contract.acceptance?.departmentCode ?? null;
  const track = contract.acceptance?.application?.cycle?.track ?? "VOLUNTEER";
  const dept = departmentCode
    ? await prisma.department.findUnique({
        where: { code: departmentCode },
        select: { requiresEpicDirector: true, requiresEpicVolunteer: true },
      })
    : null;
  const epicRequirement = epicRequirementFor(dept, track);
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const currentYear = now.getUTCFullYear();
```

Pass `ctx={{ firstName: contract.firstName, orgName, todayIso, currentYear, trainingDate: "", trainingLocation: "", department: departmentCode, track, epicRequirement }}`. `trainingDate` and `trainingLocation` are filled in Task 13.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/app/onboard/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/onboard/\[token\]/ src/modules/recruitment/services/onboarding.ts
git commit -m "feat(recruitment): render contract sections, conditions and the reworked Epic block"
```

---

### Task 13: Training date and location

**BLOCKED until #352 (`worktree-in-person-training-date`) merges to main.** Rebase this branch onto it first, then confirm `RecruitmentCycle.inPersonTrainingDate` exists:

```bash
grep -n "inPersonTrainingDate" prisma/schema.prisma
```

If that returns nothing, stop and rebase. **Do not add a second column.**

**Files:**
- Modify: `src/app/onboard/[token]/page.tsx`
- Modify: the cycle TRAINING settings form that already edits `inPersonTrainingDate` (find with `grep -rn "inPersonTrainingDate" src/app`)
- Test: `src/app/onboard/[token]/training-date.test.ts`

**Interfaces:**
- Consumes: `RecruitmentCycle.inPersonTrainingDate` (#352), `RecruitmentCycle.trainingLocation` (Task 5)
- Produces: `formatTrainingDate(at: Date | null, zone: string): string` and `formatTrainingLocation(loc: string | null): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/onboard/[token]/training-date.test.ts
import { describe, it, expect } from "vitest";
import { formatTrainingDate, formatTrainingLocation } from "./training-date";

describe("formatTrainingDate", () => {
  it("formats a date in the display zone", () => {
    expect(formatTrainingDate(new Date("2026-05-03T14:00:00Z"), "America/New_York"))
      .toBe("Sunday, May 3 at 10:00 AM");
  });
  it("falls back to a neutral phrase when unset", () => {
    expect(formatTrainingDate(null, "America/New_York")).toBe("the scheduled training date");
  });
});

describe("formatTrainingLocation", () => {
  it("prefixes a location with a space", () => {
    expect(formatTrainingLocation("in person")).toBe(" in person");
  });
  it("returns an empty string when unset, so the sentence still reads", () => {
    expect(formatTrainingLocation(null)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/onboard/\[token\]/training-date.test.ts`
Expected: FAIL — `Failed to resolve import "./training-date"`

- [ ] **Step 3: Write the implementation**

```ts
// src/app/onboard/[token]/training-date.ts
/** Formats the cycle's training date for interpolation into agreement prose.
 *  The zone comes from the configured display timezone (see src/platform/dates),
 *  not the server's, so everyone reads the same wall-clock time. */
export function formatTrainingDate(at: Date | null, zone: string): string {
  if (!at) return "the scheduled training date";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: zone,
  }).format(at).replace(", ", ", ").replace(/, (\d{1,2}:\d{2})/, " at $1");
}

/** Leading space so "{{trainingDate}}{{trainingLocation}}" reads correctly with
 *  or without a location. */
export function formatTrainingLocation(loc: string | null): string {
  return loc?.trim() ? ` ${loc.trim()}` : "";
}
```

If the `Intl` output does not match the expected string exactly, adjust the format options until the test passes rather than loosening the assertion.

- [ ] **Step 4: Wire it into page.tsx**

Replace the Task 12 placeholders:

```tsx
  const cycle = contract.acceptance?.application?.cycle ?? null;
  const zone = await getDisplayTimeZone();
  const trainingDate = formatTrainingDate(cycle?.inPersonTrainingDate ?? null, zone);
  const trainingLocation = formatTrainingLocation(cycle?.trainingLocation ?? null);
```

Use whatever the existing display-zone helper in `src/platform/dates` is named; find it with `grep -rn "export .*imeZone" src/platform/dates`.

- [ ] **Step 5: Add trainingLocation to the cycle TRAINING form**

Add a text input named `trainingLocation` beside the existing `inPersonTrainingDate` control, with placeholder `in person` or `on Zoom at 10:00 AM`, and persist it in that form's server action alongside the date.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/app/onboard/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/onboard/\[token\]/ src/app/\(app\)/recruitment/cycles/
git commit -m "feat(recruitment): interpolate the cycle training date into contract prose"
```

---

### Task 14: Server-side submit — visibility, Epic resolution, new fields

**Files:**
- Modify: `src/app/onboard/[token]/actions.ts`
- Modify: `src/modules/recruitment/services/onboarding.ts`
- Test: `src/modules/recruitment/services/onboarding.contract.test.ts`

**Interfaces:**
- Consumes: `buildContractAnswers` / `visibleContractBlocks` (Task 4), `epicRequirementFor` / `resolveEpicNeeded` (Task 6)
- Produces: `ContractSubmission` gains `pronouns?`, `staffTitle?`, `epicIdExpiration?`, `confirmations: Record<string, boolean>`, and drops `epicNeeded` (now derived server-side).

Validation runs off the **frozen `templateSnapshot`**, so the visibility filter must run against that snapshot, not the live default.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/services/onboarding.contract.test.ts
describe("submitContract visibility and Epic resolution", () => {
  it("does not require a signature for a block hidden by department", async () => {
    // snapshot has two department agreements; the acceptance is BVHD
    const res = await submitContract(token, { ...base, signatures: { bvhd: sig() } });
    expect(res.status).toBe("SUBMITTED");
  });

  it("still requires the visible department block", async () => {
    await expect(submitContract(token, { ...base, signatures: {} }))
      .rejects.toThrow(ContractValidationError);
  });

  it("sets epicNeeded true for an ALL department without asking", async () => {
    const res = await submitContract(token, { ...base, signatures: { bvhd: sig() } });
    expect(res.epicNeeded).toBe(true);
  });

  it("sets epicNeeded false for a NONE department even if the answer says yes", async () => {
    const res = await submitContract(noneToken, { ...base, customAnswers: { epic_needed_self: "yes" }, signatures: {} });
    expect(res.epicNeeded).toBe(false);
  });

  it("defers to the answer for a SOME department", async () => {
    const res = await submitContract(someToken, { ...base, customAnswers: { epic_needed_self: "yes" }, signatures: {} });
    expect(res.epicNeeded).toBe(true);
  });

  it("persists pronouns and staff title", async () => {
    const res = await submitContract(token, { ...base, pronouns: "they/them", staffTitle: "Program Manager", signatures: { bvhd: sig() } });
    expect(res.pronouns).toBe("they/them");
    expect(res.staffTitle).toBe("Program Manager");
  });

  it("requires a checkbox confirmation for a visible checkbox agreement", async () => {
    await expect(submitContract(token, { ...base, confirmations: {}, signatures: {} }))
      .rejects.toThrow(ContractValidationError);
  });
});
```

Build the fixtures following the existing patterns in this file, seeding `Department` rows with the relevant `requiresEpic*` values and writing the layout into `templateSnapshot`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/onboarding.contract.test.ts`
Expected: FAIL — hidden blocks still required, `epicNeeded` still read from input

- [ ] **Step 3: Update actions.ts**

Harvest checkbox confirmations alongside custom answers, drop `epicNeeded`, add the new fields:

```ts
  const confirmations: Record<string, boolean> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("confirm__")) confirmations[k.slice(9)] = v === "on";
  }
```

In the `input` object, remove `epicNeeded: bool("epicNeeded"),` and add:

```ts
    pronouns: str("pronouns") || undefined,
    staffTitle: str("staffTitle") || undefined,
    epicIdExpiration: str("epicIdExpiration") || undefined,
    confirmations,
```

- [ ] **Step 4: Update onboarding.ts**

Extend `ContractSubmission`: remove `epicNeeded: boolean;`, add

```ts
  pronouns?: string;
  staffTitle?: string;
  epicIdExpiration?: string; // raw YYYY-MM-DD from the date input
  confirmations?: Record<string, boolean>;
```

In `submitContract`, load the acceptance and department, resolve the requirement, and filter the snapshot before validating:

```ts
  const acceptance = await prisma.acceptance.findUnique({
    where: { id: contract.acceptanceId },
    include: { application: { include: { cycle: { select: { track: true } } } } },
  });
  const track = acceptance?.application?.cycle?.track ?? "VOLUNTEER";
  const dept = acceptance
    ? await prisma.department.findUnique({
        where: { code: acceptance.departmentCode },
        select: { requiresEpicDirector: true, requiresEpicVolunteer: true },
      })
    : null;
  const requirement = epicRequirementFor(dept, track);

  const layout = safeParseLayout(contract.templateSnapshot);
  // Validate exactly what the applicant was shown: the same condition filter the
  // client applied, over the frozen snapshot, with the authoritative context.
  const answers = buildContractAnswers(
    { ...(input.customAnswers ?? {}), hasEpic: input.hasEpic ? "on" : "" },
    { department: acceptance?.departmentCode ?? null, track, epicRequirement: requirement },
  );
  const visible = visibleContractBlocks(layout.blocks, answers);
```

Replace `for (const b of layout.blocks)` with `for (const b of visible)`, and split the agreement branch by `confirmKind`:

```ts
    if (b.kind === "agreement") {
      const kind = b.confirmKind ?? "signature";
      if (kind === "checkbox") {
        if (!input.confirmations?.[b.id]) e[`confirm__${b.id}`] = "required";
      } else if (!signed(b.id)) {
        e[`sig__${b.id}`] = "required";
      }
    }
```

Derive `epicNeeded` and persist the new columns in the `updateMany` data block:

```ts
        epicNeeded: resolveEpicNeeded(requirement, input.customAnswers?.epic_needed_self === "yes"),
        pronouns: input.pronouns?.trim() || null,
        staffTitle: input.staffTitle?.trim() || null,
        epicIdExpiration: input.epicIdExpiration ? new Date(`${input.epicIdExpiration}T00:00:00Z`) : null,
        customAnswers: { ...(input.customAnswers ?? {}), ...(input.confirmations ?? {}) } as object,
```

Also make the `initialsEnabled` check use `visible` rather than `layout.blocks`, so a hidden initials field is not required.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/services/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/onboard/\[token\]/actions.ts src/modules/recruitment/services/onboarding.ts src/modules/recruitment/services/onboarding.contract.test.ts
git commit -m "feat(recruitment): validate visible blocks only and derive epicNeeded on submit"
```

---

### Task 15: Carry pronouns and staff title through promotion

**Files:**
- Modify: `src/modules/recruitment/services/promotion.ts:86,101`
- Test: `src/modules/recruitment/services/promotion.test.ts`

**Interfaces:**
- Consumes: `OnboardingContract.pronouns`, `.staffTitle` (Task 5)
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

```ts
describe("promotion carries the new contract fields", () => {
  it("sets pronouns and staffTitle on a newly created person", async () => {
    const { personId } = await promoteContract(contractId, actorId);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: personId } });
    expect(person.pronouns).toBe("they/them");
    expect(person.staffTitle).toBe("Program Manager");
  });

  it("does not clobber an existing person's pronouns with an empty contract value", async () => {
    await prisma.person.update({ where: { id: existingId }, data: { pronouns: "she/her" } });
    await promoteContract(emptyContractId, actorId);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: existingId } });
    expect(person.pronouns).toBe("she/her");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/promotion.test.ts`
Expected: FAIL — `person.pronouns` is null

- [ ] **Step 3: Write the implementation**

In the update branch (around line 86), follow the existing `person.x || contract.x` precedence so an existing value is never overwritten by an empty one:

```ts
              pronouns: person.pronouns || contract.pronouns,
              staffTitle: person.staffTitle || contract.staffTitle,
```

In the create branch (around line 101):

```ts
              pronouns: contract.pronouns,
              staffTitle: contract.staffTitle,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/services/promotion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/promotion.ts src/modules/recruitment/services/promotion.test.ts
git commit -m "feat(recruitment): carry pronouns and staff title through promotion"
```

---

### Task 16: Builder UI for sections, conditions and confirm kind

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/contract/section-card.tsx`
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/contract/condition-editor.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/contract/agreement-card.tsx`
- Test: `src/app/(app)/recruitment/cycles/[id]/builder/contract/condition-editor.test.tsx`

**Interfaces:**
- Consumes: `applyBlockOp` with `addSection` (Task 3), `FieldCondition` (Task 2)
- Produces: `<SectionCard block onChange onRemove />`, `<ConditionEditor value onChange fieldOptions />`

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/contract/condition-editor.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConditionEditor } from "./condition-editor";

const fields = [{ value: "department", label: "Department" }, { value: "track", label: "Track" }];

describe("ConditionEditor", () => {
  it("renders as always visible when there is no condition", () => {
    render(<ConditionEditor value={undefined} onChange={() => {}} fieldOptions={fields} />);
    expect(screen.getByText(/always shown/i)).toBeTruthy();
  });

  it("emits a condition when a field is chosen", () => {
    const onChange = vi.fn();
    render(<ConditionEditor value={undefined} onChange={onChange} fieldOptions={fields} />);
    fireEvent.click(screen.getByRole("button", { name: /add condition/i }));
    expect(onChange).toHaveBeenCalledWith({ field: "department", op: "is", value: "" });
  });

  it("clears the condition when removed", () => {
    const onChange = vi.fn();
    render(<ConditionEditor value={{ field: "department", op: "is", value: "BVHD" }} onChange={onChange} fieldOptions={fields} />);
    fireEvent.click(screen.getByRole("button", { name: /remove condition/i }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/builder/contract/condition-editor.test.tsx"`
Expected: FAIL — `Failed to resolve import "./condition-editor"`

- [ ] **Step 3: Write ConditionEditor**

```tsx
"use client";
import { Select } from "@/platform/ui/select";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import type { FieldCondition } from "@/modules/recruitment/engine/field-visibility";

export function ConditionEditor({
  value, onChange, fieldOptions,
}: {
  value: FieldCondition | undefined;
  onChange: (next: FieldCondition | undefined) => void;
  fieldOptions: { value: string; label: string }[];
}) {
  if (!value) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>Always shown</span>
        <Button
          type="button" variant="ghost" size="sm"
          onClick={() => onChange({ field: fieldOptions[0]?.value ?? "", op: "is", value: "" })}
        >
          Add condition
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="When">
          <Select value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
            {fieldOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
        <Field label="Is">
          <Select
            value={value.op}
            onChange={(e) => {
              const op = e.target.value as FieldCondition["op"];
              onChange(op === "isAnswered" ? { field: value.field, op } : { field: value.field, op, value: "" });
            }}
          >
            <option value="is">equals</option>
            <option value="isNot">does not equal</option>
            <option value="isAnswered">is answered</option>
          </Select>
        </Field>
        {value.op !== "isAnswered" && (
          <Field label="Value">
            <Input
              value={typeof value.value === "string" ? value.value : ""}
              onChange={(e) => onChange({ ...value, value: e.target.value })}
            />
          </Field>
        )}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
        Remove condition
      </Button>
    </div>
  );
}
```

`isAnyOf` is deliberately not offered in the UI: the defaults use it, the schema accepts it, but hand-authoring a list is a worse experience than two `is` conditions and it keeps this control simple.

- [ ] **Step 4: Write SectionCard and wire the editor**

Model `SectionCard` on the existing `AgreementCard`: a title `Input`, a body `textarea`, a `ConditionEditor`, and a remove button, all driven through the `onChange` / `onRemove` props `ContractEditor` already passes its cards.

In `contract-editor.tsx`:
- Add `"section"` to the `dndId` switch, returning `sec:${block.id}`
- Add `const addSection = () => setLayout((prev) => applyBlockOp(prev, { t: "addSection" }));`
- Add a "Section" button beside the existing "Add agreement" control
- Render `SectionCard` for `block.kind === "section"` in the card switch

In `agreement-card.tsx`, add a `confirmKind` `Select` with the three options, defaulting to `signature`, and add a `ConditionEditor` bound to `block.visibleWhen`.

Field options for every `ConditionEditor` are the synthetic keys plus the layout's own answerable blocks:

```tsx
  const fieldOptions = [
    { value: "department", label: "Department" },
    { value: "track", label: "Track" },
    { value: "epicRequirement", label: "Epic requirement" },
    ...layout.blocks
      .filter((b) => b.kind === "custom_question")
      .map((b) => ({ value: b.key, label: b.label })),
  ];
```

- [ ] **Step 5: Run tests and lint**

Run: `npx vitest run "src/app/(app)/recruitment/" && npm run lint && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/contract/"
git commit -m "feat(recruitment): edit sections, conditions and confirm kind in the contract builder"
```

---

### Task 17: Seed the Epic requirement columns

**Files:**
- Create: `prisma/migrations/<timestamp>_seed_epic_requirements/migration.sql`

**Interfaces:**
- Consumes: `Department.requiresEpicDirector` / `.requiresEpicVolunteer` (Task 5)

The columns default to `NONE`, so without this every department resolves to "no Epic needed" and provisioning stops. This task closes that gap using the two lists from the Airtable form.

- [ ] **Step 1: Confirm the department codes**

```bash
npx tsx -e "import{prisma}from'./src/platform/db';prisma.department.findMany({select:{code:true,name:true},orderBy:{code:'asc'}}).then(r=>{console.table(r);return prisma.\$disconnect()})"
```

Map each name in the two Airtable lists to its actual `code`. Do not guess.

- [ ] **Step 2: Write the migration**

```sql
-- prisma/migrations/<timestamp>_seed_epic_requirements/migration.sql
-- Departments whose members all need Epic, per the legacy Airtable contract.
UPDATE "Department" SET "requiresEpicDirector" = 'ALL', "requiresEpicVolunteer" = 'ALL'
WHERE "code" IN ('BVHD','PCAR','EDUC','LABR','MDIC','PATS','PHAM','REFF','SRHD','SOSE','VADM');

-- Departments where it depends on the individual role.
UPDATE "Department" SET "requiresEpicDirector" = 'SOME', "requiresEpicVolunteer" = 'SOME',
  "epicGuidance" = 'Patient Navigator and Transitions of Care roles need Epic; other roles do not.'
WHERE "code" = 'LCCN';

UPDATE "Department" SET "requiresEpicDirector" = 'SOME', "requiresEpicVolunteer" = 'SOME',
  "epicGuidance" = 'Only if indicated by your directors.'
WHERE "code" = 'QAQI';

-- Every other department keeps the NONE default: Faculty Relations, Finance and
-- Development, Interpretation and Diversity, IT and Communications, Public
-- Relations, Student Recruitment, Community Relations and Advocacy.
```

Correct the code list against Step 1's output before running.

- [ ] **Step 3: Apply and verify**

Run: `npx prisma migrate dev`

Then confirm no department was missed:

```bash
npx tsx -e "import{prisma}from'./src/platform/db';prisma.department.findMany({select:{code:true,requiresEpicDirector:true,requiresEpicVolunteer:true}}).then(r=>{console.table(r);return prisma.\$disconnect()})"
```

- [ ] **Step 4: Commit**

```bash
git add prisma/migrations
git commit -m "feat(recruitment): seed department Epic requirements from the legacy contract"
```

---

### Task 18: Full verification

- [ ] **Step 1: Run the whole suite**

Run: `npm run lint && npx tsc --noEmit && npx vitest run`
Expected: PASS. `npm run lint` must cover the whole repo — typecheck and tests miss the eslint boundary rules.

- [ ] **Step 2: Render both contracts end to end**

Start the app, create a director acceptance and a volunteer acceptance in departments with different Epic requirements, send both onboarding links, and open each. Confirm:
- Section headings appear and prose renders with bullets, bold and working links
- Exactly one department responsibility block shows, matching the acceptance
- The Epic access-type select and expiration date appear only after checking "I already have an Epic ID"
- No "Epic access is required for my role" checkbox and no Spanish checkbox
- The training acknowledgement shows a real date
- Submitting with the department checkbox unticked reports a field error

- [ ] **Step 3: Verify Epic provisioning still works**

Promote a contract from an `ALL` department and confirm an `EpicRequest` is created. Promote one from a `NONE` department and confirm none is.

- [ ] **Step 4: Confirm existing layouts still parse**

```bash
npx tsx -e "import{prisma}from'./src/platform/db';import{parseContractLayout}from'./src/modules/recruitment/contract/layout';prisma.recruitmentCycleContract.findMany().then(rs=>{for(const r of rs){try{parseContractLayout(r.layout);console.log('ok',r.cycleId)}catch(e){console.error('FAIL',r.cycleId,e)}}return prisma.\$disconnect()})"
```

Expected: every row prints `ok`. A failure means a new schema property was made required somewhere it should be optional.

- [ ] **Step 5: Commit any fixes and push**

```bash
git push -u origin worktree-onboarding-form-mirror-airtable
```

---

## Notes for the implementer

- **The department prose in Task 10 is the single largest chunk of work.** It is transcription, not engineering. Take it from the Airtable screenshots in the originating conversation and verify every department code against the database before committing.
- **`templateSnapshot` is frozen at send time.** Contracts already sent keep rendering their old layout. Only newly sent contracts pick up the new defaults, and only cycles without a saved override do. This is deliberate.
- **Cycles with a saved contract override keep it.** Directors adopt the new default by resetting that cycle in the builder.
