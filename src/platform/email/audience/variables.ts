import { firstNameOf } from "@/platform/person-name";
import type { VariableDef } from "@/platform/email/templates/types";

export const PERSON_VARIABLES: VariableDef[] = [
  { name: "firstName", label: "First name", sampleValue: "Sam" },
  { name: "name", label: "Full name", sampleValue: "Sam Rivera" },
];

export function personVariables(p: { name: string }): Record<string, string> {
  // `firstName` honors a parenthetical preferred name; `name` stays verbatim,
  // because the full name is the roster's formal form and campaigns that print
  // it want exactly what an admin typed.
  return { firstName: firstNameOf(p.name), name: p.name };
}
