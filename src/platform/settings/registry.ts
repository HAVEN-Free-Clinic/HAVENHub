import { z } from "zod";
import { config } from "@/platform/config";

export type SettingInput =
  | { type: "number"; min?: number; max?: number }
  | { type: "text" }
  | { type: "textarea" }
  | { type: "boolean" }
  | { type: "select"; options: { value: string; label: string }[] };

export interface SettingDef<T> {
  /** Dotted, stable identifier, e.g. "rhd.maxProcedures". */
  key: string;
  /** Group heading in the admin UI. */
  category: string;
  /** Form field label. */
  label: string;
  /** Help text shown under the field. */
  help: string;
  /** Render hint for the auto-generated form. */
  input: SettingInput;
  /** Validates both stored DB values and submitted form input. */
  schema: z.ZodType<T>;
  /** Seed value, sourced from env via `config`. */
  envDefault: () => T;
  /** Always false -- secrets are never registered. */
  secret: false;
}

/**
 * Authoring helper: preserves per-entry type checking (the object must satisfy
 * SettingDef<T>) while letting the SETTINGS array be uniformly typed.
 */
function define<T>(def: SettingDef<T>): SettingDef<unknown> {
  return def as unknown as SettingDef<unknown>;
}

/**
 * Every admin-editable setting, declared exactly once. Adding a setting here is
 * all that is required for it to appear (auto-rendered) in /admin/settings.
 * Phase 0 registers only the canary; Phases 1-3 add the rest.
 */
export const SETTINGS: SettingDef<unknown>[] = [
  define<number>({
    key: "rhd.maxProcedures",
    category: "Operations",
    label: "Max procedures per RHD session",
    help: "Caps the number of procedures bookable in one RHD clinic session.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
    envDefault: () => config.RHD_MAX_PROCEDURES,
    secret: false,
  }),
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

/** Look up a definition. Throws for an unregistered key (programmer error). */
export function getSettingDef(key: string): SettingDef<unknown> {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unregistered setting key: ${key}`);
  return def;
}

/** Distinct categories, in first-seen order, for rendering form groups. */
export function listCategories(): string[] {
  return [...new Set(SETTINGS.map((d) => d.category))];
}
