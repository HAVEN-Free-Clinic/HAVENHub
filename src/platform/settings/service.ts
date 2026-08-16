import type { Prisma } from "@prisma/client";
import { prisma, isDbUnreachableError, isSchemaMissingError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { config } from "@/platform/config";
import { log, errorAttrs } from "@/platform/logging";
import { SETTINGS, getSettingDef, type SettingDef, type SettingInput } from "./registry";

const TTL_MS = 30_000;

type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the in-memory cache between cases. */
export function _resetSettingsCache(): void {
  cache.clear();
}

/** Parse a stored raw value against the def schema; warn and fall back on failure. */
function resolveStored(def: SettingDef<unknown>, raw: unknown): { value: unknown; ok: boolean } {
  const parsed = def.schema.safeParse(raw);
  if (parsed.success) return { value: parsed.data, ok: true };
  log.warn(`[settings] invalid stored value for "${def.key}"; using default`, {
    issues: JSON.stringify(parsed.error.issues),
  });
  return { value: def.envDefault(), ok: false };
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
 * caller. A brief DB outage (server unreachable) or a missing Setting table
 * (schema behind the code) likewise degrades to the env default rather than
 * throwing -- getSetting runs on every page render via generateMetadata, so
 * neither a momentary Neon blip nor an unmigrated database must become a
 * site-wide 500. An unregistered key throws (programmer error).
 */
export async function getSetting<T = unknown>(key: string): Promise<T> {
  const def = getSettingDef(key);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  let row: Awaited<ReturnType<typeof prisma.setting.findUnique>>;
  try {
    row = await prisma.setting.findUnique({ where: { key } });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      // The safe answer is the env default. Return it without caching so the
      // next read picks up the real stored value as soon as the DB recovers.
      log.warn(`[settings] database unreachable resolving "${key}"; using default`, errorAttrs(err));
      return def.envDefault() as T;
    }
    if (isSchemaMissingError(err)) {
      // Same safe answer, but log loud: the schema is behind the code. Run the
      // migrations to restore stored overrides.
      log.error(
        `[settings] Setting table missing resolving "${key}"; using default -- run db:migrate`,
        errorAttrs(err)
      );
      return def.envDefault() as T;
    }
    throw err;
  }
  const value = row ? resolveStored(def, row.value).value : def.envDefault();

  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value as T;
}

/**
 * Like getSetting but bypasses the 30s TTL cache: reads the row fresh and does
 * NOT populate the cache (so it can't be poisoned or serve a poisoned value).
 *
 * For the rare caller where a 30s-stale value is unsafe rather than merely
 * slightly-old, e.g. resolveEmailTransport at drain time: setSetting only
 * invalidates the writing instance's cache, so for up to 30s after an admin
 * switches email.transport to "graph", another instance still resolving "log"
 * would drain real mail through LogTransport and stamp it SENT with no retry
 * path (#76). This read sees the latest committed value instead. Still degrades
 * to the env default on a DB blip, exactly like getSetting.
 */
export async function getSettingUncached<T = unknown>(key: string): Promise<T> {
  const def = getSettingDef(key);
  let row: Awaited<ReturnType<typeof prisma.setting.findUnique>>;
  try {
    row = await prisma.setting.findUnique({ where: { key } });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn(`[settings] database unreachable resolving "${key}"; using default`, errorAttrs(err));
      return def.envDefault() as T;
    }
    if (isSchemaMissingError(err)) {
      log.error(
        `[settings] Setting table missing resolving "${key}"; using default -- run db:migrate`,
        errorAttrs(err)
      );
      return def.envDefault() as T;
    }
    throw err;
  }
  return (row ? resolveStored(def, row.value).value : def.envDefault()) as T;
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

/**
 * Resolve every setting in a category for rendering a form group. Like
 * getSetting, a brief DB outage (server unreachable) or a missing Setting table
 * (schema behind the code) degrades to the env defaults -- an admin viewing
 * /admin/settings during a momentary Neon blip, or against an unmigrated
 * database, sees the default-valued form rather than a 500. The overrides simply
 * read as empty, so every setting shows its default with isOverridden=false; the
 * result is not cached, so the next render reflects reality.
 */
export async function getCategory(category: string): Promise<ResolvedSetting[]> {
  const defs = SETTINGS.filter((d) => d.category === category && !d.hidden);

  let rows: Awaited<ReturnType<typeof prisma.setting.findMany>>;
  try {
    rows = await prisma.setting.findMany({
      where: { key: { in: defs.map((d) => d.key) } },
    });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn(
        `[settings] database unreachable resolving category "${category}"; using defaults`,
        errorAttrs(err)
      );
      rows = [];
    } else if (isSchemaMissingError(err)) {
      log.error(
        `[settings] Setting table missing resolving category "${category}"; using defaults -- run db:migrate`,
        errorAttrs(err)
      );
      rows = [];
    } else {
      throw err;
    }
  }
  const overrides = new Map(rows.map((r) => [r.key, r.value]));

  return defs.map((def) => {
    let value = def.envDefault();
    let isOverridden = false;
    if (overrides.has(def.key)) {
      const r = resolveStored(def, overrides.get(def.key));
      value = r.value;
      // A stored row exists, so the setting is overridden even if the value is
      // invalid (value falls back to the default for display). Keep isOverridden
      // true so the Reset control stays available to clear the orphan row.
      isOverridden = true;
    }
    return {
      key: def.key,
      category: def.category,
      label: def.label,
      help: def.help,
      input: def.input,
      value,
      isOverridden,
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

  if (def.validate) {
    const problem = await def.validate(parsed.data, { config, getSetting });
    if (problem) throw new SettingValidationError(key, problem);
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

/**
 * Remove an override so the value falls back to the env default; audit it.
 *
 * Unlike the read paths (getSetting / getCategory), this is a write triggered by
 * an explicit admin action, so a DB-unreachable error is left to propagate: the
 * reset genuinely did not happen and the admin must see the failure and retry.
 * Swallowing it here would redirect to "Saved." while the override still exists.
 */
export async function resetSetting(
  key: string,
  actorPersonId: string | null
): Promise<void> {
  const def = getSettingDef(key);
  const existing = await prisma.setting.findUnique({ where: { key } });
  if (!existing) return; // nothing to reset; no change, no audit

  const before = await getSetting(key);

  await prisma.setting.delete({ where: { key } });
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
