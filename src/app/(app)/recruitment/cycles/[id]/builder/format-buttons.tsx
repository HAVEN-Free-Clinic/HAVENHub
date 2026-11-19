"use client";

import type { RefObject } from "react";
import { Bold, Highlighter, Italic } from "lucide-react";
import { toggleMarker, type InlineMarker } from "@/platform/ui/inline-format";

const BUTTONS: { marker: InlineMarker; label: string; Icon: typeof Bold }[] = [
  { marker: "**", label: "Bold", Icon: Bold },
  { marker: "*", label: "Italic", Icon: Italic },
  { marker: "==", label: "Highlight", Icon: Highlighter },
];

/**
 * Bold, italic and highlight buttons for one builder text box. They wrap the
 * selected words in the markers formatInline renders (pressing again removes
 * them) and save straight away through `onChange`, the same save the box runs
 * when it loses focus.
 *
 * Rendered next to the box, not inside its <Field>: Field wraps its control in
 * a <label>, and a button inside a label steals the label's click.
 */
export function FormatButtons({
  target,
  onChange,
  disabled = false,
}: {
  target: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  function apply(marker: InlineMarker) {
    const el = target.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = toggleMarker(el.value, start, end, marker);
    el.value = next.value;
    el.focus();
    el.setSelectionRange(next.start, next.end);
    onChange(next.value.trim());
  }

  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Text formatting">
      {BUTTONS.map(({ marker, label, Icon }) => (
        <button
          key={marker}
          type="button"
          disabled={disabled}
          title={label}
          aria-label={label}
          // Keep the box focused, so its selection is still there on click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply(marker)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40"
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** One line under a formatted box, so nobody has to guess what the markers are. */
export const FORMAT_HINT = "Select words, then B, I or the highlighter. Saved as **bold**, *italic* and ==highlight==.";
