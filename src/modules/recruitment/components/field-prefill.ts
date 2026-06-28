// Helpers for repopulating a saved/prefilled answer back into a form control.
//
// A draft answer can be a string (text, single-select), an array of strings
// (multi-select checkboxes, subcommittee rank — one entry per rank, "" for an
// unranked slot), or a file-reference object ({ storedName, fileName, ... }).
// These narrow that loose shape into what each control needs.

/** A multi-value answer as a list of strings. File objects yield []. */
export function asPrefillList(prefill: unknown): string[] {
  if (Array.isArray(prefill)) return prefill.filter((v): v is string => typeof v === "string");
  if (typeof prefill === "string") return [prefill];
  return [];
}

/** A single-value answer as a string. Arrays and file objects yield "". */
export function prefillString(prefill: unknown): string {
  return typeof prefill === "string" ? prefill : "";
}

/** Whether a boolean checkbox answer should render checked. */
export function isPrefillChecked(prefill: unknown): boolean {
  return prefill === true || prefill === "on" || prefill === "true";
}
