import { desc, eq } from 'drizzle-orm';
import { encodeJson, decodeJson, type SettingValueType } from '@aia/shared';
import { z } from 'zod';
import type { DatabaseHandle } from '../client';
import { appSettings } from '../schema';

/**
 * Réglages clé/valeur typés (docs/03 §4.2). Le type est stocké (`value_type`) et
 * la validation appartient à un schéma Zod **unique par clé**, côté domaine.
 *
 * Ce dépôt reste volontairement bête : il stocke et rend le JSON. Aucune règle
 * métier, aucune valeur par défaut implicite.
 */

export type AppSettingRow = typeof appSettings.$inferSelect;

export interface SettingEntry<T> {
  key: string;
  value: T;
  valueType: SettingValueType;
  updatedAt: number;
}

export function getSetting<T>(
  handle: DatabaseHandle,
  key: string,
  schema: z.ZodType<T>,
): SettingEntry<T> | undefined {
  const row = handle.db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!row) return undefined;

  const decoded = decodeJson(schema, row.value_json, key);
  if (!decoded.ok) return undefined;
  return {
    key,
    value: decoded.value,
    valueType: row.value_type as SettingValueType,
    updatedAt: row.updated_at,
  };
}

export function setSetting<T>(
  handle: DatabaseHandle,
  key: string,
  value: T,
  valueType: SettingValueType,
  now: number,
): void {
  handle.db
    .insert(appSettings)
    .values({ key, value_json: encodeJson(value), value_type: valueType, updated_at: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value_json: encodeJson(value), value_type: valueType, updated_at: now },
    })
    .run();
}

export function listSettings(handle: DatabaseHandle): AppSettingRow[] {
  return handle.db.select().from(appSettings).orderBy(desc(appSettings.updated_at)).all();
}

export function deleteSetting(handle: DatabaseHandle, key: string): number {
  return handle.db.delete(appSettings).where(eq(appSettings.key, key)).run().changes;
}

/**
 * Fuseau horaire de l'utilisateur (docs/03 §2.2) : `app_settings.timezone`,
 * sinon le fuseau du système. Il sert aux bornes de journée et de mois des
 * budgets — jamais à un `Date` local implicite (docs/03 §17.2).
 */
export function resolveTimeZone(handle: DatabaseHandle): string {
  const stored = getSetting(handle, 'timezone', z.string().min(1));
  if (stored) return stored.value;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
