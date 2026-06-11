"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

const controlBase =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm w-full outline-none bg-white " +
  "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15 " +
  "disabled:opacity-50 disabled:bg-slate-50";

export type ComboboxOption = { value: string; label: string };

/**
 * Searchable single-select. A text input filters `options` as you type; the
 * chosen option's value is carried by a hidden input named `name` so the
 * combobox drops straight into a server-action <form> like any native control.
 *
 * Keyboard: ArrowUp/Down move the highlight, Enter selects, Escape closes.
 * Editing the text after a selection clears the value (so a stale id can't be
 * submitted alongside mismatched text); `onValueChange` reports every change so
 * callers can, e.g., disable a submit button until something is picked.
 */
export function Combobox({
  name,
  options,
  placeholder,
  emptyLabel = "No matches",
  ariaLabel,
  onValueChange,
}: {
  name: string;
  options: ComboboxOption[];
  placeholder?: string;
  emptyLabel?: string;
  ariaLabel?: string;
  onValueChange?: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [query, options]);

  function setVal(next: string) {
    setValue(next);
    onValueChange?.(next);
  }

  function choose(o: ComboboxOption) {
    setVal(o.value);
    setQuery(o.label);
    setOpen(false);
  }

  useEffect(() => {
    function onDocPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && filtered[active]) {
      e.preventDefault();
      choose(filtered[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value} />
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        className={controlBase}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (value) setVal("");
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-400">{emptyLabel}</li>
          )}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={cx(
                "cursor-pointer px-3 py-2 text-sm",
                i === active ? "bg-brand-faint text-brand" : "text-slate-700 hover:bg-slate-50",
              )}
              onMouseEnter={() => setActive(i)}
              // onMouseDown (not onClick) so selection fires before the input blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
