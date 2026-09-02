"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import type { PersonFieldView } from "@/platform/email/audience/person-fields";
import { cx } from "@/platform/ui/cx";

type FieldGroup = { name: string; fields: PersonFieldView[] };

/** Groups `fields` by `.group`, preserving the order each group name first appears. */
function groupFields(fields: PersonFieldView[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  for (const f of fields) {
    const existing = groups.find((g) => g.name === f.group);
    if (existing) existing.fields.push(f);
    else groups.push({ name: f.group, fields: [f] });
  }
  return groups;
}

/**
 * Narrows grouped fields to a search query, matched case-insensitively against
 * EITHER a field's own label or its group's name.
 *
 * Matching the group name pulls in the WHOLE group, even where no individual
 * label contains the query: searching "Schedule" must surface every
 * shift-count field (Shifts assigned this term, Upcoming assigned shifts,
 * ...), none of whose labels mention scheduling at all. A group left with no
 * matching fields is dropped entirely, not rendered with an empty body under
 * a heading nobody can act on.
 */
function filterGroups(groups: FieldGroup[], query: string): FieldGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const narrowed: FieldGroup[] = [];
  for (const g of groups) {
    const groupNameMatches = g.name.toLowerCase().includes(q);
    const fields = groupNameMatches
      ? g.fields
      : g.fields.filter((f) => f.label.toLowerCase().includes(q));
    if (fields.length > 0) narrowed.push({ name: g.name, fields });
  }
  return narrowed;
}

/**
 * Searchable, grouped replacement for a flat field `<select>`.
 *
 * Phase 2 took the audience engine from 23 fields to several dozen across
 * under a dozen groups; a flat list stopped being scannable well before that.
 * This renders a compact trigger (the field's label, with its group as
 * secondary text so a saved condition reads back without opening anything)
 * that opens a text-filterable, grouped listbox on click.
 *
 * Controlled like any other condition control here: `value` is the stored
 * field key, `onChange` reports the newly chosen key. Nothing is buffered
 * internally except the in-progress search query, which is local UI state
 * that never needs to survive a re-render from the parent.
 */
export function FieldPicker({
  fields,
  value,
  onChange,
}: {
  fields: PersonFieldView[];
  value: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  const groups = useMemo(() => groupFields(fields), [fields]);
  const filtered = useMemo(() => filterGroups(groups, query), [groups, query]);
  const flat = useMemo(() => filtered.flatMap((g) => g.fields), [filtered]);
  // A stale stored key (a field renamed or removed since the audience was
  // saved) resolves to no definition at all. That must never throw --
  // ConditionRow's own `fields.find(...) ?? fields[0]` fallback already
  // tolerates exactly this for the operator/value controls beside this one --
  // so `selected` is simply undefined here, and the trigger below renders a
  // distinct "Unknown field" state instead of crashing on `.label`.
  const selected = fields.find((f) => f.key === value);

  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);

  function openPicker() {
    setQuery("");
    setActive(0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(field: PersonFieldView) {
    onChange(field.key);
    close();
  }

  // Close on an outside click, same as Combobox (src/platform/ui/combobox.tsx).
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, [open]);

  // Move focus into the search box as soon as the popover mounts, so opening
  // via mouse OR keyboard lands the user somewhere they can immediately type.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the keyboard-highlighted option in view (list is capped at max-h-64).
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    // optionId is derived from the render-stable useId; uid is the real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, uid]);

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
      e.preventDefault();
      openPicker();
    }
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Always swallow Enter: this sits inside a <form>, and a combobox input
      // must never fall through to submitting it.
      e.preventDefault();
      const field = flat[activeIndex];
      if (field) choose(field);
    } else if (e.key === "Escape") {
      // Closing WITHOUT calling onChange is what "restores the previous
      // value" means here: nothing was ever committed while the list was
      // open, so the controlled `value` this renders from never changed.
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    }
  }

  return (
    // "flex", not "inline-flex": audience-builder.test.tsx locates the
    // MatchToggle segmented control by `div.inline-flex`, and a second
    // coincidental match here would shift that lookup's index.
    <div ref={rootRef} className="relative flex items-center gap-1.5">
      <button
        ref={triggerRef}
        type="button"
        // The visible text alone would make an OK accessible name, but
        // overriding it here means a screen reader also hears the currently
        // chosen field on every visit to this control, the way a native
        // <select>'s announced value does -- not just once the popover opens.
        aria-label={selected ? `Field: ${selected.label}, ${selected.group}` : `Field: unknown ("${value}")`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={onTriggerKeyDown}
        // eslint-disable-next-line no-restricted-syntax -- popover trigger for a custom searchable/grouped listbox; no existing primitive covers a two-line label+group trigger
        className={cx(
          "flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-2 text-left text-sm outline-none",
          "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15",
        )}
      >
        {selected ? (
          <>
            <span className="font-medium text-foreground">{selected.label}</span>
            <span className="text-xs text-subtle-foreground">{selected.group}</span>
          </>
        ) : (
          <>
            <span className="font-medium text-critical-foreground">Unknown field</span>
            <span className="text-xs text-subtle-foreground">&quot;{value}&quot;</span>
          </>
        )}
      </button>

      {/* A stored key with no surviving definition gets the same treatment as
          a deleted term/cycle/department in builder-options.ts: labelled so
          it can be recognised, and removable rather than stuck forever.
          Removing here means clearing to no key at all; ConditionRow's
          changeField falls back to the first available field for any key it
          cannot resolve (including this one), the same tolerant fallback it
          already applies when reading a stale `cond.field`. */}
      {!selected && (
        <button
          type="button"
          aria-label="Remove unknown field"
          onClick={() => onChange("")}
          // eslint-disable-next-line no-restricted-syntax -- icon-only inline control clearing a stale field reference, not a standard form action Button
          className="rounded-md p-1 text-subtle-foreground outline-none hover:bg-muted hover:text-critical-foreground focus-visible:ring-2 focus-visible:ring-brand/15"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-xl glass-panel">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length > 0 ? optionId(activeIndex) : undefined}
            aria-label="Search fields"
            autoComplete="off"
            placeholder="Search fields or groups..."
            // eslint-disable-next-line no-restricted-syntax -- combobox search input with aria-activedescendant wiring inside a custom popover, not a plain Input
            className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-subtle-foreground"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <div id={listId} role="listbox" aria-label="Fields" className="max-h-64 overflow-auto py-1">
            {flat.length === 0 && (
              <p className="px-3 py-2 text-sm text-subtle-foreground">No matching fields</p>
            )}
            {filtered.map((g, gi) => {
              const headingId = `${uid}-grp-${gi}`;
              return (
                <div key={g.name} role="group" aria-labelledby={headingId}>
                  <div
                    id={headingId}
                    className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground"
                  >
                    {g.name}
                  </div>
                  {g.fields.map((f) => {
                    const i = flat.indexOf(f);
                    return (
                      <div
                        key={f.key}
                        id={optionId(i)}
                        role="option"
                        // The accessible name is the label ALONE: the enclosing
                        // role="group" is already named by the heading above
                        // via aria-labelledby, so a screen reader announces the
                        // group once, not a second time folded into each option.
                        aria-selected={i === activeIndex}
                        onMouseEnter={() => setActive(i)}
                        // onMouseDown (not onClick), so the choice commits
                        // before the input's blur could close the list first.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          choose(f);
                        }}
                        className={cx(
                          "cursor-pointer px-3 py-2 text-sm",
                          i === activeIndex
                            ? "bg-brand-faint text-brand-fg"
                            : "text-foreground-soft hover:bg-muted",
                        )}
                      >
                        {f.label}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
