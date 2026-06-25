import { uniqueKey } from "./field-key";

export type Choice = { value: string; label: string };

export function appendChoice(options: Choice[], label: string): Choice[] {
  const value = uniqueKey(label, options.map((o) => o.value));
  return [...options, { value, label }];
}

export function renameChoice(options: Choice[], value: string, label: string): Choice[] {
  return options.map((o) => (o.value === value ? { ...o, label } : o));
}
