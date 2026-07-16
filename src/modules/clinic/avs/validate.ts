import type { AvsData } from "./types";
import type { StringFieldKey } from "./form-state";

/**
 * Validate the AVS form before a PDF is generated. Returns blocking messages plus
 * the top-level string fields to highlight/focus. A medication row with a dose or
 * cost but no name is flagged: buildSummary drops unnamed rows, so without this the
 * provider would lose it from the handout with no cue.
 */
export function validateAvs(data: AvsData): { messages: string[]; fields: StringFieldKey[] } {
  const messages: string[] = [];
  const fields: StringFieldKey[] = [];
  if (!data.lastName.trim()) {
    messages.push("Last name is required.");
    fields.push("lastName");
  }
  if (!data.visitDate.trim()) {
    messages.push("Visit date is required.");
    fields.push("visitDate");
  }
  if (!data.primaryReason.trim()) {
    messages.push("Reason for visit is required.");
    fields.push("primaryReason");
  }
  data.medications.forEach((m, i) => {
    if (!m.name.trim() && (m.dose.trim() || m.costSource.trim())) {
      messages.push(`Medication ${i + 1} has a dose or cost but no name. Add a name or clear the row.`);
    }
  });
  return { messages, fields };
}
