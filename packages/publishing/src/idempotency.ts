import { hashText } from '@aia/shared';
import type { PublishOutcome } from './capabilities';

/**
 * L'idempotence, écrite **une fois** — parce que c'est le seul défaut du produit
 * qui soit public et irréversible (docs/10 §4.8 : « le doublon de publication est
 * le pire défaut possible »).
 *
 * Trois protections, et elles ne se remplacent pas :
 *
 * 1. `uq_publication_version_account` — une seule ligne par (version, compte) ;
 * 2. `uq_publication_idempotency` — une seule ligne par clé d'idempotence ;
 * 3. `classifyPublishOutcome()` — la **réaction** décidée avant l'appel : un
 *    résultat ambigu ne se rejoue pas, il se vérifie puis se tranche.
 *
 * Ce module est pur : il ne connaît ni base, ni réseau. Ce qui rend la règle
 * testable séparément du connecteur — et donc vérifiable sans jamais publier.
 */

/**
 * Fenêtre d'anti-collision : deux publications du même compte à moins de 30 min
 * sont décalées (docs/05 §8.4). Elle sert **aussi** de grain à la clé
 * d'idempotence : deux clics à 10 secondes d'intervalle produisent la même clé,
 * donc la même ligne ; deux publications réellement espacées n'en partagent pas.
 */
export const SCHEDULE_BUCKET_MS = 30 * 60 * 1_000;

/** `'YYYY-MM-DDTHH:mm'` arrondi au quart d'heure inférieur : lisible dans un journal. */
export function scheduleBucketKey(
  scheduledFor: number | null,
  bucketMs = SCHEDULE_BUCKET_MS,
): string {
  if (scheduledFor === null) return 'immediate';
  const bucket = Math.floor(scheduledFor / bucketMs) * bucketMs;
  return new Date(bucket).toISOString().slice(0, 16);
}

/**
 * La clé d'idempotence locale : `sha256(content_version_id + platform_account_id
 * + scheduled_for_bucket)` (docs/03 §11.2).
 *
 * Elle est transmise quand la plateforme l'accepte, et elle sert **toujours** à
 * la vérification après échec et au journal. C'est la clé qui permet de dire
 * « cette publication est celle-ci, pas une autre » six mois plus tard.
 */
export function publicationIdempotencyKey(input: {
  contentVersionId: string;
  platformAccountId: string;
  scheduledFor?: number | null;
  bucketMs?: number;
}): string {
  const bucket = scheduleBucketKey(
    input.scheduledFor ?? null,
    input.bucketMs ?? SCHEDULE_BUCKET_MS,
  );
  return hashText(`${input.contentVersionId}:${input.platformAccountId}:${bucket}`);
}

/**
 * **La table de décision de docs/06 §9.1**, écrite en code plutôt que laissée à
 * l'interprétation d'un `catch`. Le handler ne décide rien : il lit cette table.
 *
 * Chaque ligne porte la **réaction** (ce qu'on fait), la **raison** (ce qu'on
 * écrit) et comment la présenter. Le cas qui compte est `ambiguous` : sa réaction
 * est `verify_then_decide`, jamais `retry`.
 */
export type PublishReaction =
  | 'settle_published'
  | 'settle_draft'
  | 'settle_scheduled'
  | 'verify_then_decide'
  | 'postpone'
  | 'expire_account'
  | 'fail_definitive'
  | 'retry_transient';

export interface PublishReactionEntry {
  reaction: PublishReaction;
  /** Raison technique, journalisée telle quelle. */
  reason: string;
  /** Ce que l'utilisateur peut faire, en une phrase (docs/08 §6.3). */
  userAction: string;
}

export const PUBLISH_REACTIONS: Record<PublishOutcome, PublishReactionEntry> = {
  published: {
    reaction: 'settle_published',
    reason: 'la plateforme a répondu avec un identifiant distant',
    userAction: 'rien : la publication est en ligne',
  },
  draft_created: {
    reaction: 'settle_draft',
    reason: 'niveau B : le contenu est déposé en brouillon privé côté plateforme',
    userAction: 'ouvrir la plateforme et publier après relecture',
  },
  scheduled: {
    reaction: 'settle_scheduled',
    reason: 'la plateforme a accepté la programmation',
    userAction: 'rien : la plateforme publiera elle-même',
  },
  ambiguous: {
    reaction: 'verify_then_decide',
    reason:
      'résultat indéterminé : l’envoi a peut-être abouti (timeout après envoi ou réponse illisible)',
    userAction: 'vérifier la plateforme, puis trancher (déjà publié, republier, abandonner)',
  },
  rate_limited: {
    reaction: 'postpone',
    reason: 'limite de débit atteinte : la publication est reportée, pas annulée',
    userAction: 'rien : la publication repartira à la fin de la fenêtre',
  },
  auth_error: {
    reaction: 'expire_account',
    reason: 'jeton refusé ou portée insuffisante',
    userAction: 'reconnecter le compte, puis relancer la publication',
  },
  server_error: {
    reaction: 'retry_transient',
    reason: 'erreur de la plateforme (5xx) : elle n’est pas de notre côté',
    userAction: 'rien pendant les essais',
  },
  rejected: {
    reaction: 'fail_definitive',
    reason: 'la plateforme a refusé le contenu',
    userAction: 'corriger le contenu indiqué, puis relancer',
  },
  manual_required: {
    reaction: 'settle_draft',
    reason: 'niveau C : le paquet manuel est la voie de publication',
    userAction: 'coller le paquet dans la plateforme et marquer publié',
  },
};

export function reactionFor(outcome: PublishOutcome): PublishReactionEntry {
  return PUBLISH_REACTIONS[outcome];
}

/**
 * Les statuts qui **interdisent** tout nouvel appel distant. Ils sont lus par le
 * handler avant le connecteur : c'est ce qui garantit qu'une seconde exécution du
 * même job ne repose pas la question à la plateforme.
 *
 * `ambiguous` y figure **avec** `needs_human_decision` : tant qu'un humain n'a pas
 * tranché, le système ne sait pas si le contenu est en ligne, donc il ne renvoie
 * rien. Après décision, le statut change (publié, ou repassé en `planned`).
 */
export const REMOTE_CALL_FORBIDDEN_STATUSES = [
  'published',
  'manual_required',
  'cancelled',
  'ambiguous',
] as const;

export function forbidsRemoteCall(status: string, needsHumanDecision: boolean): boolean {
  if (needsHumanDecision) return true;
  return (REMOTE_CALL_FORBIDDEN_STATUSES as readonly string[]).includes(status);
}
