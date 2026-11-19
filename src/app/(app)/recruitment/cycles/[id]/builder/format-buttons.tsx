"use client";

import type { RefObject } from "react";
import { Bold, Highlighter, Italic } from "lucide-react";
import { toggleMarker, type InlineMarker } from "@/platform/ui/inline-markers";
import { Button } from "@/platform/ui/button";

const BUTTONS: { marker: InlineMarker; label: string; Icon: typeof Bold }[] = [
  { marker: "**", label: "Bold", Icon: Bold },
  { marker: "*", label: "Italic", Icon: Italic },
  { marker: "==", label: "Highlight", Icon: Highlighter },
];

/** Write the new text and selection into the box. Kept outside the component:
 *  the box is an uncontrolled DOM element reached through a ref, not React state. */
function writeBox(el: HTMLInputElement | HTMLTextAreaElement, value: string, start: number, end: number) {
  el.value = value;
  el.focus();
  el.setSelectionRange(start, end);
}

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
    writeBox(el, next.value, next.start, next.end);
    onChange(next.value.trim());
  }

  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Text formatting">
      {BUTTONS.map(({ marker, label, Icon }) => (
        <Button
          key={marker}
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={label}
          aria-label={label}
          // Keep the box focused, so its selection is still there on click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply(marker)}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ))}
    </div>
  );
}

/** One line under a formatted box, so nobody has to guess what the markers are. */
export const FORMAT_HINT = "Select words, then B, I or the highlighter. Saved as **bold**, *italic* and ==highlight==.";
