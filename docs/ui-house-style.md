# HAVEN Hub UI House Style

This document is the authoritative reference for building consistent, accessible interfaces in HAVEN Hub. Follow it when adding new pages, forms, or interactive components. The ESLint rule `no-restricted-syntax` (scoped to `src/app/**/*.tsx` and `src/modules/**/*.tsx`) enforces the raw-control policy in Section 4.

---

## 1. Primitive catalog

All primitives live under `src/platform/ui/`. Import from the aliased path `@/platform/ui/<module>`.

### Buttons

| Export | Import path | Use for |
|---|---|---|
| `Button` | `@/platform/ui/button` | Standard CTA, outline, ghost, or danger action. Props: `variant` (`primary` / `outline` / `danger` / `ghost`) and `size` (`md` / `sm`). |
| `buttonClasses` | `@/platform/ui/button` | Computes a button class string when the element must be a raw `<button>` (e.g. a form-submit that reads `useFormStatus`). |
| `SubmitButton` | `@/platform/ui/submit-button` | Form submit action. Disables itself and shows a `Spinner` while the server action is pending. Prefer this over a raw `<button type="submit">` for all standard forms. |

### Inputs and form controls

| Export | Import path | Use for |
|---|---|---|
| `Input` | `@/platform/ui/input` | Single-line text, number, date, email, or search input. |
| `Textarea` | `@/platform/ui/input` | Multi-line text. |
| `Field` | `@/platform/ui/input` | Wraps a control with an accessible label and optional hint. The label element wraps the child so no `id`/`htmlFor` pair is needed. |
| `ReadonlyField` | `@/platform/ui/input` | Non-editable display row (computed values, IT-managed fields). Renders as styled plain text, not a disabled input. |
| `Select` | `@/platform/ui/select` | Native `<select>` styled to match Input. |
| `Checkbox` | `@/platform/ui/checkbox` | Brand-tinted checkbox with a visible focus ring consistent with Input/Select. |
| `Radio` | `@/platform/ui/radio` | Brand-tinted radio, rendered inside a `<label>` for click-area and accessibility. |
| `RadioGroup` | `@/platform/ui/radio` | Container for a set of `Radio` options. Accepts an optional `legend` string. |

### Form layout

| Export | Import path | Use for |
|---|---|---|
| `FormSection` | `@/platform/ui/form` | Groups related fields inside a `<fieldset>` with a small uppercase legend. |
| `FormActions` | `@/platform/ui/form` | Footer row for submit and secondary buttons. Props: `align` (`start` / `end`). |

### Surfaces

| Export | Import path | Use for |
|---|---|---|
| `Card` | `@/platform/ui/card` | Standard content surface (`rounded-2xl`, soft shadow, `p-5`). Compact variant (`size="compact"`) is `rounded-xl`, no shadow, `p-3`. |
| `cardClasses` | `@/platform/ui/card` | Generates card class strings when the element must be a link or other non-div tag. |
| `StatCard` | `@/platform/ui/stat-card` | Dashboard metric tile. Renders a big value over an uppercase label; optionally linked. |
| `Table` | `@/platform/ui/table` | Scrollable card-wrapped table. Also exports `THead`, `TR`, `TH`, `TD` for rows. |
| `Modal` | `@/platform/ui/modal` | Accessible dialog: focus trap, Escape-close, body-scroll lock, portal to `document.body`. |

### Page chrome

| Export | Import path | Use for |
|---|---|---|
| `PageHeader` | `@/platform/ui/page-header` | Top-of-page `<h1>` with optional description and action slot. |
| `SectionHeader` | `@/platform/ui/section-header` | Subsection heading. `level="eyebrow"` (default) renders the small uppercase label; `level="title"` renders a larger non-uppercase heading. Use `as="h3"` inside an `h2` context. |

### Feedback

| Export | Import path | Use for |
|---|---|---|
| `Alert` | `@/platform/ui/alert` | Inline status message near a form or action. Tones: `info`, `success`, `warning`, `error`. Sized to its content; color lives in the leading icon, not a filled banner. |
| `Badge` | `@/platform/ui/badge` | Categorical chip (status, role, tag). The chip body is neutral; tone (`brand`, `success`, `warning`, `critical`) appears as a small leading status dot. |
| `Spinner` | `@/platform/ui/spinner` | Branded loading indicator. Decorative (aria-hidden). Color is inherited from `currentColor`. Sizes: `sm`, `md` (default), `lg`. |
| `Skeleton` | `@/platform/ui/skeleton` | Shimmering placeholder block. Decorative (aria-hidden). Shape and size controlled via `className`. |

---

## 2. Design tokens

### Radii

| Context | Class |
|---|---|
| Form controls (Input, Select, Button, Checkbox, Textarea) | `rounded-lg` |
| Content cards (default) | `rounded-2xl` |
| Compact surfaces / alerts | `rounded-xl` |

Never hard-code a `rounded-*` value for these surfaces outside the primitives.

### Borders

Form controls use `border-border-strong` at rest. Cards use `border-border`. Do not reach for `border-gray-*`, `border-slate-*`, or hex values.

### Focus rings

There are exactly two focus-ring patterns in this codebase. Use the right one for the context.

**Surface / interactive pattern** (buttons, links, icon-buttons, grid-cell buttons):

```
focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand
```

**Form-control pattern** (Input, Select, Checkbox, Radio):

```
focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15
```

Both are already baked into the primitives. You only need to add them manually when suppressing the rule for a raw control.

### Semantic tokens only

Use semantic color tokens (`bg-brand`, `text-foreground`, `bg-muted`, `border-border-strong`, `text-critical`, etc.) everywhere. Never use palette tokens (`bg-teal-600`, `text-slate-500`, hex strings) in component code. Semantic tokens adapt to light/dark mode automatically.

### Naming and typography

- The product name is **HAVEN Hub** (two words) in all prose and UI labels. Identifiers stay `havenhub`.
- Do not use em-dashes (`--` or `&mdash;`) in UI copy or code comments. Use a comma, semicolon, colon, or parentheses instead.

---

## 3. Forms recipe

A standard carded form in HAVEN Hub follows this structure:

```tsx
<Card>
  <form action={serverAction}>
    <FormSection title="Personal info">
      <Field label="Full name" required>
        <Input name="name" required />
      </Field>
      <Field label="Email">
        <Input type="email" name="email" />
      </Field>
    </FormSection>

    <FormSection title="Role">
      <Field label="Department">
        <Select name="dept">
          <option value="">Select...</option>
          <option value="ed">ED</option>
        </Select>
      </Field>
      <ReadonlyField label="Member since" value={formatDate(person.createdAt)} />
    </FormSection>

    <FormActions>
      <SubmitButton>Save changes</SubmitButton>
    </FormActions>
  </form>
</Card>
```

Key points:
- Each control lives inside a `Field` (or `ReadonlyField`) wrapper.
- `FormSection` groups related fields with an uppercase legend.
- `FormActions` holds the submit and any secondary actions.
- Prefer `SubmitButton` for form submit actions so pending state is handled automatically.
- Non-editable values use `ReadonlyField`, not a `disabled` input.

---

## 4. When a raw element is acceptable

A small set of UI patterns cannot use the primitives and must remain raw elements. The ESLint rule allows these categories:

| Category | Examples |
|---|---|
| Toolbar toggles | Rich-text editor bold/italic/link buttons with dynamic active state |
| Segmented toggles | Match-mode (ALL / ANY), editor-mode (Formatted / HTML) |
| Native file inputs | `<input type="file">` styled with `file:*` pseudo-element classes |
| Drag handles | dnd-kit drag-handle buttons that receive `attributes`/`listeners` spreads from the sensor |
| Grid-cell buttons | Schedule builder compact-grid cells that use `buttonClasses` but require layout overrides |
| Popover menu items | `role="menuitem"` buttons inside a custom dropdown |

For any of these, add a suppress comment on the line **directly before** the `className` attribute:

```tsx
// eslint-disable-next-line no-restricted-syntax -- <one-line reason>
className="..."
```

For a single-line element the comment goes on the line before the element:

```tsx
{/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
<input type="file" name="file" className="..." />
```

For a multi-line element put the comment inside the attribute list, immediately before `className`:

```tsx
<button
  type="submit"
  disabled={pending}
  // eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button
  className="..."
>
```

The comment must be on the line **immediately above** the `className` attribute. Placing it above the `<button` tag will not suppress the error when `className` is on a different line, and will produce an "unused eslint-disable directive" warning.

To suppress an entire block, use:

```tsx
{/* eslint-disable no-restricted-syntax */}
<button className="...">...</button>
{/* eslint-enable no-restricted-syntax */}
```

---

## 5. Platform/ui authoring

The `src/platform/ui/` directory is excluded from the raw-control rule. Files there ARE the primitives, so raw `<button>`, `<input>`, `<select>`, and `<textarea>` elements are expected and do not need suppress comments.

When adding a new primitive, follow the existing patterns:
- Export a `*Classes` helper alongside the component when callers may need the raw class string.
- Use the semantic focus-ring tokens from Section 2.
- Keep the component dependency-free (no module imports, no server-only code unless clearly labelled).
