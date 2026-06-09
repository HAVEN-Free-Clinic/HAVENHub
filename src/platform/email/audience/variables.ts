import type { VariableDef } from "@/platform/email/templates/types";

export const PERSON_VARIABLES: VariableDef[] = [
  { name: "firstName", label: "First name", sampleValue: "Sam" },
  { name: "name", label: "Full name", sampleValue: "Sam Rivera" },
];

export function personVariables(p: { name: string }): Record<string, string> {
  const firstName = p.name.trim().split(/\s+/)[0] ?? "";
  return { firstName: p.name.trim() === "" ? "" : firstName, name: p.name };
}
