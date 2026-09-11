import { asc } from 'drizzle-orm';
import { uuidv7 } from '@aia/shared';
import type { DatabaseHandle } from '../client';
import { users } from '../schema';

/**
 * Utilisateur de l'application (docs/03 §4.1) : **un seul en V1**, mais une
 * table — parce que tout le reste du schéma porte un `owner_id`, et parce
 * qu'ajouter un second utilisateur ne doit pas exiger une migration destructive.
 *
 * L'authentification arrive à l'étape 7 (docs/10 §4.7) ; d'ici là, l'application
 * locale a besoin d'un propriétaire pour créer un projet. Il est créé au premier
 * besoin — jamais « en dur » dans le code métier.
 */

export type UserRow = typeof users.$inferSelect;

export interface OwnerOptions {
  displayName?: string;
  locale?: string;
}

/** Propriétaire courant : le plus ancien compte existant, sinon un compte local. */
export function ensureLocalOwner(
  handle: DatabaseHandle,
  nowMs: number,
  options: OwnerOptions = {},
): UserRow {
  const existing = handle.db.select().from(users).orderBy(asc(users.created_at)).get();
  if (existing) return existing;

  const owner: UserRow = {
    id: uuidv7(nowMs),
    display_name: options.displayName ?? 'Propriétaire local',
    email: null,
    password_hash: null,
    locale: options.locale ?? 'fr-FR',
    created_at: nowMs,
    updated_at: nowMs,
  };
  handle.db.insert(users).values(owner).run();
  return owner;
}

/** Identifiant du propriétaire courant, en le créant si nécessaire. */
export function ensureLocalOwnerId(handle: DatabaseHandle, nowMs: number): string {
  return ensureLocalOwner(handle, nowMs).id;
}
