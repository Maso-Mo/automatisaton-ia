import { z } from 'zod';
import { contentTargetSchema } from '@aia/shared';
import type { JobSpec } from './types';

/**
 * Les **spécifications** des jobs métier, partagées par les deux processus :
 * l'API qui enfile et le worker qui exécute (docs/02 §3).
 *
 * Une seule définition, donc un seul endroit où corriger un schéma d'entrée, une
 * priorité ou une politique de retry. Recopier ces valeurs dans la route et dans
 * le handler produirait deux vérités : la première divergence serait invisible
 * jusqu'au jour où un job serait refusé par l'un et accepté par l'autre.
 *
 * Le handler, lui, **n'est pas ici** : il vit dans le worker, qui seul a le droit
 * d'exécuter (docs/05 §1.1).
 */

/** Le job de rédaction : une entrée, un appel au `platform_writer`, N versions (docs/05 §4.3). */
export const GENERATE_CONTENT_JOB = 'generate_content';

export const generateContentInputSchema = z.object({
  projectId: z.string().min(1),
  angleId: z.string().min(1),
  /**
   * Les cibles concernées, dans l'ordre du domaine. Une régénération demandée
   * par l'utilisateur n'en porte **qu'une** : c'est ce qui garantit qu'on
   * n'envoie pas au modèle les plateformes qu'il ne doit pas réécrire
   * (docs/05 §4.4).
   */
  targets: z.array(contentTargetSchema).min(1).max(5),
  /** `initial` : première version. `regenerated` : nouvelle version, jamais un écrasement. */
  mode: z.enum(['initial', 'regenerated']),
  /**
   * Le contenu **exact** à réécrire, renseigné ⇔ `mode = 'regenerated'`.
   *
   * Sans lui, une régénération devrait deviner sa cible à partir du couple
   * (angle, plateforme) — et se tromperait dès que l'utilisateur a généré deux
   * contenus du même angle. L'identifiant est posé par l'API, qui le lit dans la
   * ligne sur laquelle l'utilisateur a cliqué : jamais deviné (docs/05 §4.4).
   */
  contentItemId: z.string().min(1).nullish(),
  /** Consigne de réécriture de l'utilisateur : transmise telle quelle, jamais devinée. */
  instruction: z.string().min(4).max(600).nullish(),
});

export type GenerateContentInput = z.infer<typeof generateContentInputSchema>;

/**
 * Politique du job de rédaction.
 *
 * `maxAttempts: 3` suit docs/05 §4.6 : un fournisseur indisponible mérite trois
 * tentatives, une clé invalide n'en mérite aucune (c'est la politique de retry
 * qui tranche, pas ce nombre). Le lease est plus long que celui du `noop` : un
 * appel multi-plateformes écrit jusqu'à cinq textes longs.
 */
export const generateContentSpec: JobSpec<GenerateContentInput> = {
  type: GENERATE_CONTENT_JOB,
  inputSchema: generateContentInputSchema,
  maxAttempts: 3,
  backoff: (attempt) => 30_000 * 4 ** (Math.max(1, attempt) - 1),
  leaseMs: 180_000,
  idempotent: false,
  priority: 3,
  requiresNetwork: true,
  // Un seul job en attente par (angle, mode, cibles) : cliquer deux fois sur
  // « Générer » ne doit pas payer deux fois la même rédaction (docs/03 §14.1).
  // Une régénération porte sur **un** contenu : sa clé est l'identifiant de ce
  // contenu, sinon deux régénérations du même angle se dédupliqueraient à tort.
  dedupeKey: (input) =>
    input.contentItemId
      ? `content:regenerate:${input.contentItemId}`
      : `content:${input.angleId}:${input.mode}:${[...input.targets].sort().join(',')}`,
};
