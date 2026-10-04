import { contentTargetSpec } from '@aia/shared';
import type {
  ConnectorCapabilities,
  ManualPackage,
  PlatformConnector,
  PublishRequest,
  PublishResult,
  VerificationResult,
  VerifiedFact,
} from './capabilities';

/**
 * Le **connecteur simulé** : celui qui prouve l'abstraction (docs/06 §11.3).
 *
 * « Si le pipeline de publication tourne de bout en bout avec un connecteur
 * factice, l'abstraction tient. Si un test exige un appel réseau réel,
 * l'abstraction fuit. » C'est aussi le seul moyen d'exercer le cas le plus
 * dangereux du produit — **l'envoi dont on ne connaît pas l'issue** — sans
 * publier quoi que ce soit.
 *
 * Il est **scriptable plutôt que moqueur** : on décrit ce que la plateforme fait
 * (`behaviour`), et il **compte** ce qui a réellement été publié (`remotePosts`).
 * Un test peut donc affirmer « une seule publication distante après 20 exécutions
 * du job », ce qui est le critère de sortie de l'étape 8.
 */

export type SimulatedPublishBehaviour =
  | 'success'
  /** Le contenu part, mais la réponse se perd : le cas `ambiguous` de docs/06 §9.1. */
  | 'timeout_after_send'
  /** 2xx sans identifiant exploitable : publié *peut-être*, jamais « published ». */
  | 'success_without_remote_id'
  | 'rate_limited'
  | 'rejected'
  | 'server_error'
  | 'auth_error';

export type SimulatedVerification = 'found' | 'not_found' | 'unsupported';

export interface SimulatedConnectorOptions {
  platform?: PublishRequest['platform'];
  level?: 'A' | 'B' | 'C';
  behaviour?: SimulatedPublishBehaviour;
  verification?: SimulatedVerification;
  /** Retard annoncé par un 429, en millisecondes. */
  retryAfterMs?: number;
}

export interface SimulatedConnector extends PlatformConnector {
  /** Les appels **réellement reçus** par la plateforme simulée, dans l'ordre. */
  readonly publishCalls: PublishRequest[];
  /** L'état distant : une ligne par contenu réellement publié. */
  readonly remotePosts: Array<{ remoteId: string; body: string; lifecycle: 'PUBLISHED' | 'DRAFT' }>;
  setBehaviour(behaviour: SimulatedPublishBehaviour): void;
  setVerification(verification: SimulatedVerification): void;
}

export function createSimulatedConnector(
  options: SimulatedConnectorOptions = {},
): SimulatedConnector {
  const platform: PublishRequest['platform'] = options.platform ?? 'linkedin';
  let behaviour = options.behaviour ?? 'success';
  let verification = options.verification ?? 'found';
  const publishCalls: PublishRequest[] = [];
  const remotePosts: SimulatedConnector['remotePosts'] = [];
  const verificationFacts: readonly VerifiedFact[] = [
    {
      capability: 'connecteur simulé',
      statement:
        'Connecteur de test : il respecte le contrat `PlatformConnector` sans ouvrir de socket (docs/06 §11.3).',
      sourceUrl: 'tests/support',
      checkedAt: '2026-10-02',
    },
  ];

  const capabilities: ConnectorCapabilities = {
    directPublish: options.level !== 'B' && options.level !== 'C',
    draft: options.level === 'B',
    schedule: false,
    analytics: false,
    videoUpload: false,
    imageUpload: false,
    maxTextLength: { value: 3_000, advisory: true, checkedAt: '2026-10-02' },
    textLimits: [
      {
        field: 'body',
        value: 3_000,
        unit: 'characters',
        advisory: true,
        checkedAt: '2026-10-02',
        sourceUrl: 'tests/support',
      },
    ],
    requiresReview: false,
    level: options.level ?? 'A',
    verifyPublished: true,
    verification: verificationFacts,
  };

  const recordRemotePost = (req: PublishRequest, lifecycle: 'PUBLISHED' | 'DRAFT'): string => {
    const remoteId = `urn:li:${lifecycle === 'DRAFT' ? 'draft' : 'share'}:${remotePosts.length + 1}`;
    remotePosts.push({ remoteId, body: req.body, lifecycle });
    return remoteId;
  };

  const attempt = (req: PublishRequest, lifecycle: 'PUBLISHED' | 'DRAFT'): PublishResult => {
    switch (behaviour) {
      case 'timeout_after_send':
        // Le contenu est **réellement parti** : c'est ce qui rend le doublon
        // possible, et donc le test utile.
        recordRemotePost(req, lifecycle);
        return {
          outcome: 'ambiguous',
          message: 'Délai dépassé après envoi : l’issue n’est pas déterminée.',
        };
      case 'success_without_remote_id':
        recordRemotePost(req, lifecycle);
        return {
          outcome: 'ambiguous',
          message: 'Réponse 201 sans identifiant : le contenu est peut-être en ligne.',
        };
      case 'rate_limited':
        return {
          outcome: 'rate_limited',
          message: 'Limite de débit atteinte : la publication est reportée.',
          retryAfterMs: options.retryAfterMs ?? 15 * 60 * 1_000,
        };
      case 'rejected':
        return { outcome: 'rejected', message: 'Le contenu a été refusé par la plateforme.' };
      case 'server_error':
        return { outcome: 'server_error', message: 'Erreur 503 de la plateforme.' };
      case 'auth_error':
        return { outcome: 'auth_error', message: 'Jeton refusé : reconnectez le compte.' };
      default: {
        const remoteId = recordRemotePost(req, lifecycle);
        return lifecycle === 'DRAFT'
          ? { outcome: 'draft_created', remoteId, remoteStatus: 'DRAFT' }
          : { outcome: 'published', remoteId, remoteStatus: 'PUBLISHED' };
      }
    }
  };

  return {
    platform,
    publishCalls,
    remotePosts,
    capabilities: () => capabilities,
    setBehaviour(next) {
      behaviour = next;
    },
    setVerification(next) {
      verification = next;
    },
    async authenticate(): Promise<void> {},
    async validateContent(req: PublishRequest) {
      const spec = contentTargetSpec(req.target);
      const ok = req.body.length <= spec.bodyMaxChars;
      return {
        ok,
        issues: ok
          ? []
          : [
              {
                field: 'body' as const,
                severity: 'blocking' as const,
                message: `Le texte fait ${req.body.length} caractères ; la limite est ${spec.bodyMaxChars}.`,
                limit: spec.bodyMaxChars,
                actual: req.body.length,
              },
            ],
        warnings: [],
      };
    },
    async publish(req: PublishRequest) {
      publishCalls.push(req);
      return attempt(req, 'PUBLISHED');
    },
    async createDraft(req: PublishRequest) {
      publishCalls.push(req);
      return attempt(req, 'DRAFT');
    },
    async schedule(): Promise<PublishResult> {
      return { outcome: 'rejected', message: 'Connecteur simulé : pas de programmation.' };
    },
    async verifyPublished(req: PublishRequest): Promise<VerificationResult> {
      if (verification === 'unsupported') {
        return {
          verifiable: false,
          found: false,
          reason: 'Connecteur simulé : vérification distante indisponible.',
        };
      }
      const post = remotePosts.find((candidate) => candidate.body === req.body);
      if (verification === 'found' && post) {
        return {
          verifiable: true,
          found: true,
          remoteId: post.remoteId,
          reason: 'Le contenu a été retrouvé côté plateforme : aucune republication.',
        };
      }
      return {
        verifiable: true,
        found: false,
        reason: 'Le contenu n’est pas présent côté plateforme.',
      };
    },
    async fetchMetrics(): Promise<Array<Record<string, unknown>>> {
      return [];
    },
    async buildManualPackage(req: PublishRequest): Promise<ManualPackage> {
      return {
        platform,
        contentVersionId: req.contentVersionId,
        body: req.body,
        title: req.title,
        hook: req.hook,
        description: req.description,
        hashtags: [...req.hashtags],
        mentions: [...req.mentions],
        instructions: 'Connecteur simulé : ce paquet sert aux tests.',
        checklist: ['Test'],
        assets: [...req.assets],
        expectedMedia: null,
        deepLink: null,
      };
    },
  };
}
