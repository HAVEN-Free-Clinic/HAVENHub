import { Select } from "./select";
import { SPANISH_PROFICIENCY_LEVELS } from "@/platform/languages/catalog";

export function ScoreOptions({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <option value="">N/A</option>
      {SPANISH_PROFICIENCY_LEVELS.map((l) => (
        <option key={l.score} value={l.score}>
          {l.score} - {l.label}
        </option>
      ))}
    </Select>
  );
}
