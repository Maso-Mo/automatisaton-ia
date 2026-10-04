import type { createPublishingStore } from '@aia/database';
import {
  publishContentSpec,
  type JobContext,
  type JobDefinition,
  type PublishContentInput,
} from '@aia/queue';
import {
  NotFoundError,
  TransientError,
  ValidationError,
  serializeError,
  toAppError,
  type Clock,
  type ContentTarget,
  type PlatformId,
} from '@aia/shared';
import type { AppLogger } from '@aia/observability';
import {
  forbidsRemoteCall,
  reactionFor,
  type PublishRequest,
  type PublishResult,
  type ResolvedConnector,
  type VerificationResult,
} from '@aia/publishing';
import type { BudgetBrake } from '@aia/analytics';

/**
 * Le handler du job `publish_content` — **le pipeline le plus risqué du produit**
 * (docs/05 §8). Il produit un effet de bord irréversible et public ; sa
 * conception est donc dominée par une seule question : *que se passe-t-il si on
 * ne sait pas si ça a marché ?*
 *
 * Ce que le handler garantit, dans l'ordre où ça compte :
 *
 * 1. **il ne repose jamais la question à la plateforme** quand l'état de la
 *    publication est déjà tranché (`needs_human_decision`, `published`,
 *    `manual_required`, `cancelled`). C'est ce qui fait qu'une 20ᵉ reprise
 *    forcée ne produit toujours qu'**une** publication distante ;
 * 2. **il prend un verrou en base avant d'envoyer** (`claimForPublish`) : deux
 *    jobs concurrents ne peuvent pas publier tous les deux ;
 * 3. **une ambiguïté se vérifie, elle ne se rejoue pas** : `verifyPublished()`
 *    d'abord, puis décision humaine si la plateforme ne sait pas répondre ;
 * 4. **un dépassement de budget retient** la publication (elle est reprogrammée)
 *    au lieu de la détruire — le travail repart avec un budget neuf ;
 * 5. **un refus est explicable en une phrase** (docs/10 §4.8) : le message de la
 *    plateforme est écrit tel quel dans la tentative et dans la note de décision.
 *
 * Ce qui n'est **pas** décidé ici : la politique de reprise. Le handler lève une
 * erreur typée et la file applique la règle (docs/02 §12).
 */

export interface PublicationContentSource {
  item(id: string): {
    id: string;
    projectId: string;
    platform: PlatformId;
    target: ContentTarget;
    state: string;
    approvedVersionId: string | null;
  } | null;
  version(id: string): {
    id: string;
    body: string;
    title: string | null;
    hook: string | null;
    hashtags: string[];
    mentions: string[];
    mediaAssetIds: string[];
    approvedAt: number | null;
  } | null;
}

export interface PublishContentHandlerDeps {
  publications: ReturnType<typeof createPublishingStore>;
  content: PublicationContentSource;
  /** Choisit le connecteur et le niveau (A/B/C) **avant** l'appel. */
  resolveConnector(input: { platform: PlatformId; accountId: string }): ResolvedConnector;
  /**
   * Le frein de budget, évalué avant l'action (docs/08 §8.1). Il rend « retenu »
   * ou « autorisé », jamais un booléen seul.
   */
  budgetBrake(input: { projectId: string; estimatedMicroUsd: number }): BudgetBrake;
  /** Report d'une publication retenue ou limitée : elle est reprogrammée, pas perdue. */
  reschedule(input: { publicationId: string; delayMs: number; reason: string }): Promise<void>;
  /** Prévient le domaine qu'une publication est réglée (état du contenu, étape 8). */
  onSettled(publicationId: string, outcome: string): void;
  /** Le verrou a été acquis : le calendrier peut afficher `publishing`. */
  onPublishing?(publicationId: string): void;
  /** Marque le compte en `rate_limited` ou `expired` selon la réponse. */
  onAccountState(input: {
    accountId: string;
    state: 'rate_limited' | 'expired' | 'connected';
    error?: string | null;
    rateLimitResetAt?: number | null;
  }): void;
  /** Coût estimé d'une publication, en micro-dollars (`PUBLISH_ESTIMATED_COST_USD`). */
  estimatedCostMicroUsd: number;
  /** Délai de report quand le budget retient la publication (défaut : 1 heure). */
  holdDelayMs?: number;
  clock: Clock;
  logger: AppLogger;
}

export interface PublishContentOutput {
  publicationId: string;
  /** `published` | `draft_created` | `held` | `postponed` | `skipped` | `ambiguous` */
  outcome: string;
  level: 'A' | 'B' | 'C';
  remoteId?: string;
  /** Ce qui a été décidé, en une phrase : le journal du job doit suffire à comprendre. */
  reason: string;
}

/** Construit la requête de publication à partir de la **version approuvée** gelée. */
function buildPublishRequest(
  deps: PublishContentHandlerDeps,
  publication: NonNullable<ReturnType<ReturnType<typeof createPublishingStore>['getPublication']>>,
): PublishRequest {
  const item = deps.content.item(publication.contentItemId);
  if (!item) {
    throw new NotFoundError(`Contenu introuvable : ${publication.contentItemId}`, {
      code: 'CONTENT_NOT_FOUND',
    });
  }
  const version = deps.content.version(publication.contentVersionId);
  if (!version) {
    throw new NotFoundError(`Version de contenu introuvable : ${publication.contentVersionId}`, {
      code: 'CONTENT_VERSION_NOT_FOUND',
    });
  }
  const account = deps.publications.getAccount(publication.platformAccountId);
  return {
    contentItemId: item.id,
    contentVersionId: version.id,
    target: item.target,
    platform: publication.platform,
    body: version.body,
    title: version.title,
    hook: version.hook,
    description: version.body,
    hashtags: version.hashtags,
    mentions: version.mentions,
    idempotencyKey: publication.idempotencyKey,
    ...(account
      ? {
          account: {
            platformAccountId: account.id,
            platform: account.platform,
            remoteAccountId: account.remoteAccountId,
            label: account.accountLabel,
            scopes: account.scopes,
          },
        }
      : {}),
    assets: version.mediaAssetIds.map((path) => ({ path, kind: 'media' })),
  };
}

/**
 * La catégorie d'une erreur devient une issue de tentative (docs/03 §11.3) : la
 * correspondance est écrite une fois, ici, plutôt que devinée dans chaque `catch`.
 */
function attemptOutcomeForError(
  category: ReturnType<typeof toAppError>['category'],
): 'auth_error' | 'validation_error' | 'server_error' | 'ambiguous' | 'network_error' {
  switch (category) {
    case 'auth':
      return 'auth_error';
    case 'validation':
    case 'capability':
    case 'forbidden':
    case 'conflict':
      return 'validation_error';
    case 'ambiguous':
      return 'ambiguous';
    default:
      return 'server_error';
  }
}

/**
 * Délai de reprogrammation quand la vérification distante a **confirmé** que le
 * contenu n'est pas en ligne : le rejouer est alors sans risque de doublon, mais
 * on laisse passer un court moment pour ne pas heurter un quota naissant.
 */
const PUBLISH_RECHECK_DELAY_MS = 5 * 60 * 1_000;

/**
 * **Le seul chemin qui traite une issue indéterminée** (docs/06 §9.1, §9.2 ;
 * docs/05 §8.3). Il est appelé dans deux situations, et dans les deux cas la
 * publication est en `publishing` :
 *
 * - le processus précédent est mort entre l'envoi et la confirmation (reprise
 *   après crash) ;
 * - le connecteur vient de répondre `ambiguous` (timeout après envoi, 2xx sans
 *   identifiant exploitable).
 *
 * La règle est unique : **on ne rejoue pas un POST ambigu, on pose la question à
 * la plateforme**, et si elle ne sait pas répondre (`verifiable: false`) on ne
 * devine pas — on marque une décision humaine. C'est ce qui rend vingt reprises
 * forcées inoffensives : la deuxième exécution retrouve une publication déjà
 * tranchée et s'arrête (`forbidsRemoteCall`).
 */
async function resolveAmbiguity(
  deps: PublishContentHandlerDeps,
  publicationId: string,
  reason: string,
  ctx?: JobContext,
): Promise<PublishContentOutput> {
  const publication = deps.publications.getPublication(publicationId);
  if (!publication) {
    throw new NotFoundError(`Publication introuvable : ${publicationId}`, {
      code: 'PUBLICATION_NOT_FOUND',
    });
  }

  const request = buildPublishRequest(deps, publication);
  const resolved = deps.resolveConnector({
    platform: publication.platform,
    accountId: publication.platformAccountId,
  });

  let verification: VerificationResult;
  try {
    verification = await resolved.connector.verifyPublished(request);
  } catch (error) {
    // Une vérification qui échoue ne prouve rien : elle vaut « je ne sais pas ».
    verification = {
      verifiable: false,
      found: false,
      reason: `La vérification distante a échoué : ${toAppError(error).message}`,
    };
  }
  const diagnostics = verification.diagnostics;

  // 1. La plateforme confirme : le contenu est en ligne. On règle, sans republier.
  if (verification.verifiable && verification.found) {
    deps.publications.recordAttempt({
      publicationId: publication.id,
      outcome: 'success',
      startedAt: deps.clock.nowMs(),
      httpStatus: diagnostics?.httpStatus ?? null,
      response: diagnostics?.responseBody ?? null,
      errorMessage: verification.reason,
    });
    deps.publications.settlePublication(publication.id, {
      status: 'published',
      remoteId: verification.remoteId ?? publication.remoteId ?? null,
      remoteUrl: verification.remoteUrl ?? publication.remoteUrl ?? null,
      remoteStatus: publication.remoteStatus ?? 'PUBLISHED',
      needsHumanDecision: false,
      decisionNote: verification.reason,
      publishedAt: publication.publishedAt ?? deps.clock.nowMs(),
    });
    deps.onSettled(publication.id, 'published');
    await ctx?.emitEvent({
      step: 'done',
      progress: 100,
      message: `Vérification distante : le contenu est bien en ligne (${verification.reason}).`,
    });
    return {
      publicationId: publication.id,
      outcome: 'published',
      level: resolved.level,
      ...(verification.remoteId ? { remoteId: verification.remoteId } : {}),
      reason: verification.reason,
    };
  }

  // 2. La plateforme répond « rien ici » : rejouer est sans risque de doublon.
  if (verification.verifiable && !verification.found) {
    deps.publications.recordAttempt({
      publicationId: publication.id,
      outcome: 'ambiguous',
      startedAt: deps.clock.nowMs(),
      response: diagnostics?.responseBody ?? null,
      errorMessage: verification.reason,
    });
    deps.publications.settlePublication(publication.id, {
      status: 'planned',
      needsHumanDecision: false,
      decisionNote: `Vérifié non publié — ${verification.reason}`,
    });
    await deps.reschedule({
      publicationId: publication.id,
      delayMs: PUBLISH_RECHECK_DELAY_MS,
      reason: verification.reason,
    });
    await ctx?.emitEvent({
      step: 'postponed',
      level: 'warn',
      message:
        'Vérification distante : le contenu n’est pas en ligne, la publication est reprogrammée.',
    });
    return {
      publicationId: publication.id,
      outcome: 'postponed',
      level: resolved.level,
      reason: verification.reason,
    };
  }

  // 3. La plateforme ne sait pas répondre : décision humaine, jamais une reprise.
  deps.publications.recordAttempt({
    publicationId: publication.id,
    outcome: 'ambiguous',
    startedAt: deps.clock.nowMs(),
    response: diagnostics?.responseBody ?? null,
    errorMessage: verification.reason,
  });
  deps.publications.settlePublication(publication.id, {
    status: 'ambiguous',
    needsHumanDecision: true,
    decisionNote: `${reason} — ${verification.reason}`,
  });
  deps.onSettled(publication.id, 'ambiguous');
  await ctx?.emitEvent({
    step: 'ambiguous',
    level: 'warn',
    message:
      'Issue indéterminée : le contenu est peut-être en ligne. Vérifiez la plateforme, puis tranchez.',
    data: { verifiable: verification.verifiable },
  });
  return {
    publicationId: publication.id,
    outcome: 'ambiguous',
    level: resolved.level,
    reason: verification.reason,
  };
}

export function createPublishContentHandler(
  deps: PublishContentHandlerDeps,
): JobDefinition<PublishContentInput, PublishContentOutput> {
  const holdDelayMs = deps.holdDelayMs ?? 60 * 60 * 1_000;

  return {
    ...publishContentSpec,
    handler: async (input, ctx): Promise<PublishContentOutput> => {
      const startedAt = deps.clock.nowMs();
      await ctx.setStep('load_publication', 5);

      const publication = deps.publications.getPublication(input.publicationId);
      if (!publication) {
        throw new NotFoundError(`Publication introuvable : ${input.publicationId}`, {
          code: 'PUBLICATION_NOT_FOUND',
        });
      }

      /**
       * **Premier verrou : l'état déjà tranché.** Si la publication est ambiguë,
       * publiée, en attente d'un humain ou annulée, on ne repose **pas** la
       * question à la plateforme : c'est ce qui rend 20 reprises forcées
       * inoffensives (docs/09 §4.1).
       */
      if (publication.status === 'publishing') {
        // Le processus précédent est mort entre l'envoi et la confirmation : on ne
        // sait pas si le contenu est parti. Aucune reprise — vérification, puis
        // décision humaine si la plateforme ne sait pas répondre.
        return resolveAmbiguity(
          deps,
          publication.id,
          'reprise après interruption pendant l’envoi',
          ctx,
        );
      }
      if (forbidsRemoteCall(publication.status, publication.needsHumanDecision)) {
        const reason =
          publication.status === 'ambiguous'
            ? 'Publication ambiguë non tranchée : aucune republication automatique.'
            : `Publication déjà réglée (${publication.status}).`;
        await ctx.emitEvent({
          step: 'skipped',
          message: reason,
          data: { status: publication.status },
        });
        return { publicationId: publication.id, outcome: 'skipped', level: 'C', reason };
      }

      /**
       * **Deuxième verrou : le budget, avant l'action.** Un plafond atteint
       * **retient** la publication : elle est reprogrammée et repartira avec un
       * budget neuf (docs/11 §2.7). Rien n'est perdu, rien n'est détruit.
       */
      const brake = deps.budgetBrake({
        projectId: publication.projectId,
        estimatedMicroUsd: deps.estimatedCostMicroUsd,
      });
      if (brake.held) {
        const reason = brake.reason ?? 'Budget atteint : la publication est retenue.';
        deps.publications.settlePublication(publication.id, {
          status: 'planned',
          decisionNote: reason,
        });
        await deps.reschedule({ publicationId: publication.id, delayMs: holdDelayMs, reason });
        await ctx.emitEvent({ step: 'held', level: 'warn', message: reason });
        return { publicationId: publication.id, outcome: 'held', level: 'C', reason };
      }

      /**
       * **Troisième verrou : la réservation en base.** Le passage à `publishing`
       * est conditionnel : deux jobs concurrents ne peuvent pas l'obtenir tous les
       * deux, et la tentative n'est comptée qu'une fois (docs/03 §11.2).
       */
      await ctx.setStep('claim', 15);
      const claim = deps.publications.claimForPublish(publication.id);
      if (!claim.claimed) {
        const current = claim.publication;
        if (current?.status === 'publishing') {
          return resolveAmbiguity(deps, publication.id, 'publication déjà en cours d’envoi', ctx);
        }
        const reason = `Publication non réservable dans son état « ${current?.status ?? 'inconnu'} ».`;
        return { publicationId: publication.id, outcome: 'skipped', level: 'C', reason };
      }
      deps.onPublishing?.(publication.id);

      const request = buildPublishRequest(deps, publication);
      const resolved = deps.resolveConnector({
        platform: publication.platform,
        accountId: publication.platformAccountId,
      });

      /**
       * **Validation locale avant envoi** (docs/06 §1.1) : un refus détecté ici
       * coûte zéro quota, zéro tentative distante, et il est explicable.
       */
      await ctx.setStep('validate', 25);
      const validation = await resolved.connector.validateContent(request);
      if (!validation.ok) {
        const message =
          validation.issues.find((issue) => issue.severity === 'blocking')?.message ??
          'Le contenu ne respecte pas les règles connues de la plateforme.';
        deps.publications.recordAttempt({
          publicationId: publication.id,
          outcome: 'validation_error',
          startedAt,
          request: { local: true, target: request.target },
          errorCode: 'PUBLICATION_VALIDATION_FAILED',
          errorMessage: message,
        });
        deps.publications.settlePublication(publication.id, {
          status: 'failed',
          decisionNote: message,
        });
        deps.onSettled(publication.id, 'failed');
        await ctx.emitEvent({ step: 'rejected', level: 'warn', message });
        throw new ValidationError(message, { code: 'PUBLICATION_VALIDATION_FAILED' });
      }

      await ctx.setStep(resolved.level === 'B' ? 'create_draft' : 'publish', 40);
      let result: PublishResult;
      try {
        result =
          resolved.level === 'B'
            ? await resolved.connector.createDraft(request)
            : await resolved.connector.publish(request);
      } catch (error) {
        const appError = toAppError(error);
        const outcome = attemptOutcomeForError(appError.category);
        deps.logger.warn(
          {
            err: serializeError(appError),
            publicationId: publication.id,
            category: appError.category,
          },
          'appel de publication en échec',
        );
        deps.publications.recordAttempt({
          publicationId: publication.id,
          outcome,
          startedAt,
          errorCode: appError.code ?? null,
          errorMessage: appError.message,
        });
        if (appError.category === 'auth') {
          deps.onAccountState({
            accountId: publication.platformAccountId,
            state: 'expired',
            error: appError.message,
          });
        }
        if (appError.category === 'transient' || appError.category === 'internal') {
          // Erreur de la plateforme : la file décide d'une reprise bornée.
          throw error;
        }
        deps.publications.settlePublication(publication.id, {
          status: 'failed',
          decisionNote: appError.message,
        });
        deps.onSettled(publication.id, 'failed');
        await ctx.emitEvent({ step: 'failed', level: 'error', message: appError.message });
        throw error;
      }

      /**
       * **La table de décision de docs/06 §9.1, appliquée telle quelle.** Le
       * handler ne choisit pas : il lit `reactionFor(result.outcome)` et exécute.
       */
      const entry = reactionFor(result.outcome);
      const diagnostics = result.diagnostics;
      const attempt = (
        outcome: Parameters<typeof deps.publications.recordAttempt>[0]['outcome'],
        extra?: {
          httpStatus?: number | null;
          request?: unknown;
          response?: unknown;
          errorCode?: string | null;
          errorMessage?: string | null;
        },
      ) =>
        deps.publications.recordAttempt({
          publicationId: publication.id,
          outcome,
          startedAt,
          httpStatus: extra?.httpStatus ?? diagnostics?.httpStatus ?? null,
          request: extra?.request ?? diagnostics?.requestSummary,
          response: extra?.response ?? diagnostics?.responseBody ?? null,
          errorCode: extra?.errorCode ?? null,
          errorMessage: extra?.errorMessage ?? result.message ?? null,
        });

      switch (entry.reaction) {
        case 'settle_published':
        case 'settle_scheduled': {
          attempt('success');
          deps.publications.settlePublication(publication.id, {
            status: 'published',
            remoteId: result.remoteId ?? null,
            remoteUrl: result.remoteUrl ?? null,
            remoteStatus: result.remoteStatus ?? null,
            needsHumanDecision: false,
            decisionNote: null,
            publishedAt: deps.clock.nowMs(),
          });
          deps.onSettled(publication.id, 'published');
          await ctx.emitEvent({
            step: 'done',
            progress: 100,
            message: `Publié sur ${publication.platform} (niveau ${resolved.level}).`,
            data: { remoteId: result.remoteId ?? null, level: resolved.level },
          });
          return {
            publicationId: publication.id,
            outcome: 'published',
            level: resolved.level,
            ...(result.remoteId ? { remoteId: result.remoteId } : {}),
            reason: entry.reason,
          };
        }

        case 'settle_draft': {
          attempt('success');
          deps.publications.settlePublication(publication.id, {
            status: 'manual_required',
            remoteId: result.remoteId ?? null,
            remoteUrl: result.remoteUrl ?? null,
            remoteStatus: result.remoteStatus ?? 'DRAFT',
            needsHumanDecision: false,
            decisionNote:
              result.message ??
              'Brouillon distant créé : la publication finale reste une décision humaine (niveau B).',
          });
          deps.onSettled(publication.id, 'manual_required');
          await ctx.emitEvent({
            step: 'done',
            progress: 100,
            message: 'Brouillon créé sur la plateforme : publiez-le après relecture.',
            data: { remoteId: result.remoteId ?? null },
          });
          return {
            publicationId: publication.id,
            outcome: 'draft_created',
            level: resolved.level,
            ...(result.remoteId ? { remoteId: result.remoteId } : {}),
            reason: entry.reason,
          };
        }

        case 'verify_then_decide': {
          // **On ne rejoue pas un POST ambigu.** Le résultat est indéterminé ;
          // on pose la question à la plateforme (`verifyPublished`), et c'est
          // `resolveAmbiguity` qui tranche : publié, reprogrammé, ou décision
          // humaine (docs/05 §8.3, docs/06 §9.2).
          attempt('ambiguous', {
            errorMessage: result.message ?? entry.reason,
          });
          return await resolveAmbiguity(deps, publication.id, entry.reason, ctx);
        }

        case 'postpone': {
          // Un 429 reporte, il n'annule pas : la date de reprise est conservée
          // sur le compte pour que le planificateur évite la fenêtre bloquée.
          attempt('rate_limited', {
            httpStatus: diagnostics?.httpStatus ?? 429,
            errorMessage: result.message ?? entry.reason,
          });
          const rateLimitResetAt =
            result.retryAfterMs !== undefined ? deps.clock.nowMs() + result.retryAfterMs : null;
          deps.onAccountState({
            accountId: publication.platformAccountId,
            state: 'rate_limited',
            error: result.message ?? null,
            rateLimitResetAt,
          });
          deps.publications.settlePublication(publication.id, {
            status: 'planned',
            decisionNote: result.message ?? entry.reason,
          });
          await deps.reschedule({
            publicationId: publication.id,
            delayMs: result.retryAfterMs ?? holdDelayMs,
            reason: entry.reason,
          });
          await ctx.emitEvent({
            step: 'postponed',
            level: 'warn',
            message: result.message ?? entry.reason,
          });
          return {
            publicationId: publication.id,
            outcome: 'postponed',
            level: resolved.level,
            reason: entry.reason,
          };
        }

        case 'expire_account': {
          // Jeton refusé ou portée insuffisante : aucun retry en boucle, on
          // marque le compte et on l'explique (docs/06 §9.1).
          attempt('auth_error', { errorMessage: result.message ?? entry.reason });
          deps.onAccountState({
            accountId: publication.platformAccountId,
            state: 'expired',
            error: result.message ?? entry.reason,
          });
          deps.publications.settlePublication(publication.id, {
            status: 'failed',
            decisionNote: result.message ?? entry.reason,
          });
          deps.onSettled(publication.id, 'failed');
          await ctx.emitEvent({
            step: 'failed',
            level: 'error',
            message: result.message ?? entry.reason,
          });
          return {
            publicationId: publication.id,
            outcome: 'failed',
            level: resolved.level,
            reason: entry.reason,
          };
        }

        case 'fail_definitive': {
          // Refus explicite de la plateforme : une phrase, pas une erreur technique.
          attempt('rejected_by_platform', { errorMessage: result.message ?? entry.reason });
          deps.publications.settlePublication(publication.id, {
            status: 'failed',
            decisionNote: result.message ?? entry.reason,
          });
          deps.onSettled(publication.id, 'failed');
          await ctx.emitEvent({
            step: 'rejected',
            level: 'warn',
            message: result.message ?? entry.reason,
          });
          return {
            publicationId: publication.id,
            outcome: 'failed',
            level: resolved.level,
            reason: entry.reason,
          };
        }

        case 'retry_transient': {
          // Erreur de la plateforme (5xx) : on rend la main à la file — c'est
          // elle qui décide d'une reprise bornée (docs/02 §12). Le contenu est
          // remis en `queued` pour que la reprise puisse le réserver à nouveau.
          attempt('server_error', { errorMessage: result.message ?? entry.reason });
          deps.publications.settlePublication(publication.id, {
            status: 'queued',
            decisionNote: result.message ?? entry.reason,
          });
          await ctx.emitEvent({
            step: 'retry',
            level: 'warn',
            message: `Erreur de la plateforme : nouvelle tentative planifiée (${entry.reason}).`,
          });
          throw new TransientError(result.message ?? entry.reason, {
            code: 'PUBLISH_SERVER_ERROR',
          });
        }

        default: {
          // Le type est fermé : ce cas est inatteignable, et le `never` le
          // prouve à la compilation. Un `default` silencieux masquerait l'ajout
          // d'une réaction oubliée.
          const unreachable: never = entry.reaction;
          throw new Error(`Réaction de publication inconnue : ${String(unreachable)}`);
        }
      }
    },
  };
}
