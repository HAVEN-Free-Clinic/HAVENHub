"use client";

import { useState } from "react";
import { Textarea } from "@/platform/ui/input";
import { cx } from "@/platform/ui/cx";

/** Count words the way an applicant reads them: whitespace-delimited, empty = 0. */
export function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * A paragraph (LONG_TEXT) textarea with a live, soft word counter. When
 * `wordLimit` is set it shows "127 / 300 words" below the field and turns
 * critical once over -- but it NEVER blocks input or submission (the limit is
 * deliberately not enforced server-side). The textarea stays uncontrolled
 * (defaultValue), matching FieldPreview's other text controls; the counter keeps
 * its own local count, seeded from whatever initial value the field carries
 * (e.g. a resumed draft), so no re-render is forced on the parent form.
 */
export function WordCountTextarea({
  wordLimit,
  onChange,
  ...rest
}: React.ComponentProps<typeof Textarea> & { wordLimit: number | null }) {
  const initial =
    typeof rest.value === "string"
      ? rest.value
      : typeof rest.defaultValue === "string"
        ? rest.defaultValue
        : "";
  const [count, setCount] = useState(() => countWords(initial));
  const over = wordLimit != null && count > wordLimit;
  return (
    <>
      <Textarea
        rows={4}
        onChange={(e) => {
          if (wordLimit != null) setCount(countWords(e.target.value));
          onChange?.(e);
        }}
        {...rest}
      />
      {wordLimit != null && (
        <span
          className={cx(
            "mt-1 block text-right text-xs tabular-nums",
            over ? "text-critical-foreground" : "text-muted-foreground",
          )}
        >
          {count} / {wordLimit} words
        </span>
      )}
    </>
  );
}
