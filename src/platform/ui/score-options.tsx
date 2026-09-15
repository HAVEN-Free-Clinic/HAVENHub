import type { ComponentProps } from "react";
import { Select } from "./select";
import { SPANISH_PROFICIENCY_LEVELS } from "@/platform/languages/catalog";

/**
 * The 1-5 Spanish score select.
 *
 * Uncontrolled with `defaultValue` everywhere except the review queue, which
 * passes `value` and `onChange` because its bulk bar has to post the score each
 * row currently shows, from outside that row's form.
 */
export function ScoreOptions({
  name,
  defaultValue,
  value,
  onChange,
}: {
  name: string;
  defaultValue?: string;
  value?: string;
  onChange?: ComponentProps<"select">["onChange"];
}) {
  return (
    <Select name={name} defaultValue={defaultValue} value={value} onChange={onChange}>
      <option value="">N/A</option>
      {SPANISH_PROFICIENCY_LEVELS.map((l) => (
        <option key={l.score} value={l.score}>
          {l.score} - {l.label}
        </option>
      ))}
    </Select>
  );
}
