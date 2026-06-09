import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { SETTINGS, getSettingDef, type SettingInput } from "./registry";

const TTL_MS = 30_000;

type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the in-memory cache between cases. */
export function _resetSettingsCache(): void {
  cache.clear();
}

/** Thrown when a submitted value fails its registry schema. */
export class SettingValidationError extends Error {
  constructor(
    public readonly key: string,
    message: string
  ) {
    super(message);
    this.name = "SettingValidationError";
  }
}

/**
 * Resolve a setting: validated DB override -> env default. An invalid stored
 * value logs a warning and falls back to the default; it never throws to the
 * caller. An unregistered key throws (programmer error).
 */
export async function getSetting<T = unknown>(key: string): Promise<T> {
  const def = getSettingDef(key);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const row = await prisma.setting.findUnique({ where: { key } });
  let value: unknown;
  if (row) {
    const parsed = def.schema.safeParse(row.value);
    if (parsed.success) {
      value = parsed.data;
    } else {
      console.warn(
        `[settings] invalid stored value for "${key}"; using default`,
        parsed.error.issues
      );
      value = def.envDefault();
    }
  } else {
    value = def.envDefault();
  }

  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value as T;
}

export type ResolvedSetting = {
  key: string;
  category: string;
  label: string;
  help: string;
  input: SettingInput;
  value: unknown;
  isOverridden: boolean;
};

/** Resolve every setting in a category for rendering a form group. */
export async function getCategory(category: string): Promise<ResolvedSetting[]> {
  const defs = SETTINGS.filter((d) => d.category === category);
  const rows = await prisma.setting.findMany({
    where: { key: { in: defs.map((d) => d.key) } },
  });
  const overrides = new Map(rows.map((r) => [r.key, r.value]));

  return defs.map((def) => {
    const hasOverride = overrides.has(def.key);
    let value = def.envDefault();
    if (hasOverride) {
      const parsed = def.schema.safeParse(overrides.get(def.key));
      if (parsed.success) value = parsed.data;
    }
    return {
      key: def.key,
      category: def.category,
      label: def.label,
      help: def.help,
      input: def.input,
      value,
      isOverridden: hasOverride,
    };
  });
}

/** Validate, persist an override, invalidate cache, and audit. */
export async function setSetting(
  key: string,
  rawValue: unknown,
  actorPersonId: string | null
): Promise<void> {
  const def = getSettingDef(key);
  const parsed = def.schema.safeParse(rawValue);
  if (!parsed.success) {
    throw new SettingValidationError(
      key,
      parsed.error.issues.map((i) => i.message).join("; ")
    );
  }

  const before = await getSetting(key);
  const value = parsed.data as Prisma.InputJsonValue;

  await prisma.setting.upsert({
    where: { key },
    update: { value, updatedById: actorPersonId },
    create: { key, value, updatedById: actorPersonId },
  });
  cache.delete(key);

  await recordAudit({
    actorPersonId,
    action: "setting.update",
    entityType: "Setting",
    entityId: key,
    before: before as Prisma.InputJsonValue,
    after: value,
  });
}

/** Remove an override so the value falls back to the env default; audit it. */
export async function resetSetting(
  key: string,
  actorPersonId: string | null
): Promise<void> {
  const def = getSettingDef(key);
  const before = await getSetting(key);

  await prisma.setting.deleteMany({ where: { key } });
  cache.delete(key);

  await recordAudit({
    actorPersonId,
    action: "setting.reset",
    entityType: "Setting",
    entityId: key,
    before: before as Prisma.InputJsonValue,
    after: def.envDefault() as Prisma.InputJsonValue,
  });
}
