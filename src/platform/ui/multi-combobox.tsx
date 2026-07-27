"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "./cx";

export type MultiComboboxOption = {
  value: string;
  label: string;
  /** Optional trailing annotation (e.g. "3 applicants"), shown on the dropdown row and, when set, on the chip. */
  note?: string;
};

const boxBase =
  "flex flex-wrap items-center gap-1.5 rounded-lg border border-border-strong px-2 py-1.5 text-sm w-full bg-surface " +
  "focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15";

/**
 * Searchable multi-select. Type to filter `options`, then pick items to add them
 * as removable chips. Each selected value is carried by its own hidden input
 * named `name`, so the control drops straight into a server-action <form> and is
 * read back with formData.getAll(name) -- exactly like a group of checkboxes.
 *
 * Keyboard: ArrowUp/Down move the highlight, Enter adds the highlighted option,
 * Backspace on an empty query removes the last chip, Escape closes the list.
 * `onChange` reports the full selected-value list on every change.
 */
export function MultiCombobox({
  name,
  options,
  defaultValue = [],
  placeholder,
  emptyLabel = "No matches",
  ariaLabel,
  onChange,
}: {
  name: string;
  options: MultiComboboxOption[];
  defaultValue?: string[];
  placeholder?: string;
  emptyLabel?: string;
  ariaLabel?: string;
  onChange?: (values: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(defaultValue);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Selectable options = everything not already chosen, filtered by the query
  // (matched on both the human label and the raw value/code).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        !selectedSet.has(o.value) &&
        (!q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)),
    );
  }, [query, options, selectedSet]);

  function commit(next: string[]) {
    setSelected(next);
    onChange?.(next);
  }
  function add(value: string) {
    if (selectedSet.has(value)) return;
    commit([...selected, value]);
    setQuery("");
    setActive(0);
    // Close after each pick (like the single-select Combobox) so the floating
    // option list never lingers over -- and intercept clicks meant for -- the
    // fields below. Clicking the input again (onClick) reopens it to add more.
    setOpen(false);
  }
  function remove(value: string) {
    commit(selected.filter((v) => v !== value));
  }

  useEffect(() => {
    function onDocPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, []);

  // Keep the keyboard-highlighted option visible (the listbox is capped at
  // max-h-56, so long lists would otherwise scroll the active row out of view).
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        // ArrowDown that OPENS a closed list highlights the first option. After
        // add() the list is closed with active===0 and the query cleared, so
        // advancing unconditionally opened the list AND jumped to the second option,
        // adding the wrong department (#139).
        setOpen(true);
        setActive(0);
      } else {
        setActive((i) => Math.min(i + 1, filtered.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Always swallow Enter so it can never fall through to implicit submission of
      // the surrounding (server-action) form -- after add() the list is closed but
      // the input keeps focus, and a second Enter used to submit the form (#77).
      e.preventDefault();
      if (open && filtered[active]) add(filtered[active].value);
    } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
      remove(selected[selected.length - 1]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      {selected.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
      <div
        className={cx(boxBase, "cursor-text")}
        onMouseDown={(e) => {
          // Click empty space in the box to focus the input; chip buttons handle their own clicks.
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {selected.map((v) => {
          const opt = byValue.get(v);
          const label = opt?.label ?? v;
          return (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-md bg-brand-faint px-2 py-0.5 text-xs font-medium text-brand-fg"
            >
              {label}
              {opt?.note && <span className="font-normal text-brand-fg/70">· {opt.note}</span>}
              <button
                type="button"
                aria-label={`Remove ${label}`}
                className="ml-0.5 text-base leading-none text-brand-fg/60 hover:text-brand-fg"
                onClick={() => remove(v)}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered.length > 0 ? `${listId}-opt-${active}` : undefined}
          aria-label={ariaLabel}
          autoComplete="off"
          className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-subtle-foreground"
          placeholder={selected.length === 0 ? placeholder : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          // Reopen on click too: after a pick the input keeps focus while the
          // list is closed, so onFocus alone would not fire on the next click.
          onClick={() => setOpen(true)}
          // Close when focus leaves the whole control (e.g. Tab away); option
          // clicks use onMouseDown+preventDefault so they never blur first.
          onBlur={(e) => {
            if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl glass-panel py-1"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-sm text-subtle-foreground">{emptyLabel}</li>
          )}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={false}
              data-value={o.value}
              className={cx(
                "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm",
                i === active ? "bg-brand-faint text-brand-fg" : "text-foreground-soft hover:bg-muted",
              )}
              onMouseEnter={() => setActive(i)}
              // onMouseDown (not onClick) so selection fires before the input blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                add(o.value);
              }}
            >
              <span>{o.label}</span>
              {o.note && <span className="shrink-0 text-xs text-subtle-foreground">{o.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
