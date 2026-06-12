# Email Audience Conditions: Target by Any Person Field

Date: 2026-06-11
Branch: chore/external-cron-email (worktree)
Status: Approved design, pending implementation plan

## Problem

The campaign audience builder can only filter recipients on five hardcoded
fields (`status`, `role`, `department`, `complianceStatus`, `hasEpicId`) using
three operator kinds (`enum`, `multiEnum`, `boolean`). There is no text field
support and no text operators, so an admin cannot target recipients by name,
NetID, email, Epic ID, phone, or any other free-text attribute. The goal is to
let admins condition an audience on essentially any meaningful person
attribute, including a curated set of relational facts.

## Scope (confirmed with user)

- **Direct Person fields plus key relations.** Not a generic "expose every
  column" reflection, and not an advanced query DSL.
- **Text operators wanted:** contains, is exactly, starts with, ends with,
  is any of (paste a list), is empty, is not empty.

## Non-goals

- Auto-introspecting every Prisma scalar or relation.
- A raw/advanced query mode or free-form DSL.
- Nested condition groups (the flat ALL / ANY match stays). Can revisit later.
- Changes to send paths, audience compilation wrapper, or the existing
  recipient-count preview, all of which already work.

## Approach: field registry with per-field compilers

Each targetable field becomes one entry in a registry. An entry declares its
`kind`, the operators it allows, optional select `options`, and a `compile`
function that returns a Prisma `PersonWhereInput` fragment. Scalar text columns
share a generated compiler; relations get bespoke compilers. The builder UI
gains an operator dropdown and a value control that switches on
`(kind, operator)`. Adding a future field is a single registry entry.

This is the natural extension of the existing `personFieldWhere` switch, and it
unifies direct fields and relations: a relation is just a field whose `compile`
emits a `{ relation: { some: {...} } }` fragment.

### Rejected alternatives

- **Auto-introspect every Prisma scalar.** This is the "literally every field"
  scope the user did not pick. It leaks unsafe and poorly labeled fields,
  cannot present nice labels or grouping, and still needs hand-written relation
  support.
- **Advanced query DSL / raw builder.** Maximum flexibility, wrong audience.
  Unsafe and unusable for non-technical admins.

## Detailed design

### 1. Operator model (`src/platform/email/audience/types.ts`)

Expand the operator union; the `AudienceCondition` shape is unchanged so saved
audiences keep deserializing:

```ts
export type ConditionOp =
  | "eq"          // is exactly (text: case-insensitive; enum: exact)
  | "in"          // is any of (enum multi-select, multiEnum, or pasted text list)
  | "contains"    // text, case-insensitive
  | "startsWith"  // text, case-insensitive
  | "endsWith"    // text, case-insensitive
  | "isEmpty"     // text: null or ""
  | "isNotEmpty"  // text: present and non-empty
  | "isTrue"      // boolean
  | "isFalse";    // boolean
```

`isAudience` keeps its current permissive guard (validates `recordType`,
`match`, and that each condition has a string `field`). Operator validity is
enforced at compile time, not in the type guard, so older payloads never hard
fail the guard.

### 2. Field registry (`src/platform/email/audience/person-fields.ts`)

```ts
export type PersonFieldKind = "text" | "enum" | "multiEnum" | "boolean";

export type PersonFieldDef = {
  key: string;
  label: string;
  group: string;                 // for UI grouping, e.g. "Identity", "Status & roles", "Records"
  kind: PersonFieldKind;
  operators: ConditionOp[];      // which operators this field offers
  options?: { value: string; label: string }[];   // enum / multiEnum
  compile: (cond: AudienceCondition, ctx: AudienceCtx) => Prisma.PersonWhereInput;
};
```

A `textField(key, label, group, column)` helper generates the `compile` for a
plain string column, handling every text operator with case-insensitive
matching (`mode: "insensitive"` for contains / eq / startsWith / endsWith).

`personFieldWhere(cond, ctx)` becomes: find the field by `cond.field` (throw on
unknown, as today), then return `field.compile(cond, ctx)`.

#### Fields exposed

Direct text (`kind: "text"`, group "Identity", text operator set):

- `name` (Full name)
- `netId` (NetID)
- `contactEmail` (Email)
- `epicId` (Epic ID)
- `phone` (Phone)
- `yaleAffiliation` (Yale affiliation)
- `gradYear` (Grad year)

Direct boolean (`kind: "boolean"`, group "Attributes", ops isTrue / isFalse):

- `spanishSpeaking` (Spanish-speaking)
- `licensedRN` (Licensed RN)

Existing, unchanged (group "Status & roles"):

- `status` (enum), `role` (relation), `department` (relation, multiEnum),
  `complianceStatus` (relation, multiEnum), `hasEpicId` (boolean).

Curated relations, new (group "Records"):

- `hasOpenEpicRequest` (boolean): isTrue ->
  `{ epicRequests: { some: { status: "PENDING" } } }`; isFalse -> `none`.
- `hasDisciplinaryAction` (boolean): isTrue ->
  `{ disciplinaryActions: { some: {} } }`; isFalse -> `none`.

(`epicRequests` and `disciplinaryActions` are the person-as-subject relations on
the `Person` model.)

### 3. Text operator compilation

For a text column `col`:

- `contains` -> `{ [col]: { contains: value, mode: "insensitive" } }`
- `eq` -> `{ [col]: { equals: value, mode: "insensitive" } }`
- `startsWith` -> `{ [col]: { startsWith: value, mode: "insensitive" } }`
- `endsWith` -> `{ [col]: { endsWith: value, mode: "insensitive" } }`
- `in` (is any of) -> parse the value (split on commas and newlines, trim, drop
  blanks) into a list; `{ [col]: { in: list } }`. Exact match is correct for
  identifier lists (NetIDs, emails, Epic IDs).
- `isEmpty` -> `{ OR: [{ [col]: null }, { [col]: "" }] }`
- `isNotEmpty` -> `{ AND: [{ [col]: { not: null } }, { [col]: { not: "" } }] }`

### 4. Safety: incomplete conditions match nobody

Consistent with the existing "empty audience matches nobody" safeguard, an
incomplete condition never widens the audience:

- A text condition whose operator requires a value (`contains`, `eq`,
  `startsWith`, `endsWith`) with a blank value compiles to `{ id: { in: [] } }`
  (match nothing), never to "match everyone".
- An `in` (is any of) condition whose parsed list is empty compiles to
  `{ id: { in: [] } }`.
- `isEmpty` / `isNotEmpty` need no value and are always complete.

This keeps an unfinished filter from turning into an accidental send-all.

### 5. Builder UI (`src/app/admin/email/campaigns/[id]/audience-builder.tsx`)

- **Field selector:** grouped `<optgroup>` by `field.group` for scanability.
- **Operator selector (new):** a `<select>` populated from `field.operators`
  with human labels (contains, is exactly, starts with, ends with, is any of,
  is empty, is not empty, yes/no for boolean).
- **Value control:** switches on `(kind, op)`:
  - text + value operator -> single-line text input.
  - text + `in` (is any of) -> textarea, paste comma or newline separated.
  - text + `isEmpty` / `isNotEmpty` -> no value control.
  - enum -> existing single select.
  - multiEnum -> existing checkbox group (departments injected as today).
  - boolean -> existing yes / no select.
- When the field changes, reset the condition to that field's first operator
  and a matching default value (extends the current `changeField` logic).

### 6. Wiring

`page.tsx` already passes `PERSON_FIELDS` and `departments` into the builder and
serializes the audience to a hidden input. No server-action changes are needed;
the richer `PERSON_FIELDS` and the operator-aware builder flow through the
existing save, preview, test, and send actions unchanged.

## Files touched

- `src/platform/email/audience/types.ts` (expand `ConditionOp`)
- `src/platform/email/audience/person-fields.ts` (registry, helpers, new fields,
  text + relation compilers)
- `src/app/admin/email/campaigns/[id]/audience-builder.tsx` (operator dropdown,
  value-control switch, grouped field selector)
- Tests: `person-fields.test.ts`, `compile.test.ts`

Not touched: `compile.ts`, `resolve.ts`, `variables.ts`, the send paths, and
the recipient-count preview.

## Testing (TDD)

Write failing tests first, then implement:

1. Each text operator compiles to the expected Prisma fragment
   (contains / eq / startsWith / endsWith / in / isEmpty / isNotEmpty),
   case-insensitive where specified.
2. "Is any of" parses comma and newline separated lists, trims, and drops
   blank entries.
3. Safety: a value-requiring text op with a blank value, and an `in` with an
   empty parsed list, both compile to match-nobody.
4. New boolean relations (`hasOpenEpicRequest`, `hasDisciplinaryAction`) compile
   to the correct `some` / `none` fragments for isTrue and isFalse.
5. Existing field behavior (status, role, department, complianceStatus,
   hasEpicId) is unchanged (regression).
6. `resolve.test.ts` still passes (no behavior change expected).

## Open questions

- Relational set: design ships with `hasOpenEpicRequest` and
  `hasDisciplinaryAction`. Add or drop during plan or review if priorities
  differ (e.g. training completion, shift assignment).
