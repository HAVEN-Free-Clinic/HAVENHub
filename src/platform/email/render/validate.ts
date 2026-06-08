import { tokenize } from "./tokens";

export type ValidationResult = {
  ok: boolean;
  unknownVariables: string[];
  errors: string[];
};

export function validateTemplate(source: string, allowedVariables: string[]): ValidationResult {
  const allowed = new Set(allowedVariables);
  const unknown = new Set<string>();
  const errors: string[] = [];
  let depth = 0;

  for (const t of tokenize(source)) {
    if (t.type === "var" || t.type === "rawVar") {
      if (!allowed.has(t.name)) unknown.add(t.name);
    } else if (t.type === "ifOpen") {
      if (!allowed.has(t.name)) unknown.add(t.name);
      depth++;
    } else if (t.type === "ifClose") {
      if (depth === 0) errors.push("Unexpected {{/if}} without matching {{#if}}");
      else depth--;
    } else if (t.type === "else") {
      if (depth === 0) errors.push("{{else}} outside of an {{#if}} block");
    }
  }

  if (depth > 0) errors.push(`${depth} unclosed {{#if}} block(s)`);

  const unknownVariables = [...unknown];
  return { ok: unknownVariables.length === 0 && errors.length === 0, unknownVariables, errors };
}
