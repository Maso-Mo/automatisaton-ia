import {
  contentTargetSpec,
  type ContentFormat,
  type ContentTarget,
  type PlatformId,
} from '@aia/shared';

export interface VerifiedTextLimit {
  field: 'body' | 'title' | 'description';
  value: number;
  unit: 'characters' | 'utf16_runes' | 'utf8_bytes';
  advisory: boolean;
  checkedAt: string;
  sourceUrl: string;
}

export interface ConnectorCapabilities {
  directPublish: boolean;
  draft: boolean;
  schedule: boolean;
  analytics: boolean;
  videoUpload: boolean;
  imageUpload: boolean;
  maxTextLength: { value: number; advisory: boolean; checkedAt: string | null };
  textLimits: readonly VerifiedTextLimit[];
  requiresReview: boolean;
  level: 'C';
}

export interface PublishRequest {
  contentItemId: string;
  contentVersionId: string;
  target: ContentTarget;
  platform: PlatformId;
  body: string;
  title: string | null;
  hook: string | null;
  description: string | null;
  hashtags: string[];
  mentions: string[];
  idempotencyKey: string;
  scheduledAt?: Date;
  assets: Array<{ path: string; kind: string }>;
}

export interface ValidationReport {
  ok: boolean;
  issues: Array<{
    field: 'title' | 'body' | 'description' | 'hashtags' | 'media' | 'cta' | 'other';
    severity: 'blocking' | 'warning';
    message: string;
    limit?: number;
    actual?: number;
  }>;
  warnings: string[];
}

export interface ManualPackage {
  platform: PlatformId;
  contentVersionId: string;
  body: string;
  title: string | null;
  hook: string | null;
  description: string | null;
  hashtags: string[];
  mentions: string[];
  instructions: string;
  checklist: string[];
  assets: Array<{ path: string; kind: string }>;
  expectedMedia: string | null;
  deepLink: string | null;
}

export interface PublishResult {
  outcome:
    'published' | 'draft_created' | 'scheduled' | 'rejected' | 'ambiguous' | 'manual_required';
  remoteId?: string;
  remoteUrl?: string;
  raw?: unknown;
}

export interface PlatformConnector {
  readonly platform: PlatformId;
  capabilities(): ConnectorCapabilities;
  authenticate(accountId: string): Promise<void>;
  validateContent(req: PublishRequest): Promise<ValidationReport>;
  createDraft(req: PublishRequest): Promise<PublishResult>;
  publish(req: PublishRequest): Promise<PublishResult>;
  schedule(req: PublishRequest, at: Date): Promise<PublishResult>;
  fetchMetrics(remoteId: string, since: Date): Promise<Array<Record<string, unknown>>>;
  buildManualPackage(req: PublishRequest): Promise<ManualPackage>;
}

interface ManualConnectorConfig {
  platform: PlatformId;
  deepLink: string;
  instructions: string;
  checklist: string[];
  textLimits: readonly VerifiedTextLimit[];
}

const CHECKED_AT = '2026-10-02';
const LINKEDIN_POSTS_API =
  'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/posts-api';
const REDDIT_LIMITS = 'https://developers.reddit.com/apps/rainpostink';
const TIKTOK_DIRECT_POST =
  'https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post';
const YOUTUBE_VIDEOS = 'https://developers.google.com/youtube/v3/docs/videos';

const EXPECTED_MEDIA: Record<ContentFormat, string | null> = {
  post_texte: null,
  post_image: 'Image correspondant au texte approuvé.',
  video_courte: 'Vidéo verticale correspondant au script approuvé.',
  video_longue: 'Vidéo longue, miniature et chapitrage correspondant au plan approuvé.',
  thread: null,
  article: null,
};

const CONFIGS: Record<'linkedin' | 'reddit' | 'tiktok' | 'youtube', ManualConnectorConfig> = {
  linkedin: {
    platform: 'linkedin',
    deepLink: 'https://www.linkedin.com/feed/?shareActive=true',
    instructions:
      'Copier le texte final, ouvrir LinkedIn, le coller, relire l’aperçu puis publier.',
    checklist: ['Relire les sauts de ligne', 'Vérifier les mentions', 'Confirmer la publication'],
    textLimits: [
      {
        field: 'body',
        value: 3_000,
        unit: 'characters',
        advisory: true,
        checkedAt: CHECKED_AT,
        sourceUrl: LINKEDIN_POSTS_API,
      },
    ],
  },
  reddit: {
    platform: 'reddit',
    deepLink: 'https://www.reddit.com/submit',
    instructions:
      'Choisir le subreddit, copier le titre puis le corps, sélectionner le flair et publier.',
    checklist: [
      'Vérifier les règles du subreddit',
      'Choisir le flair',
      'Déclarer tout lien avec le sujet',
    ],
    textLimits: [
      {
        field: 'title',
        value: 300,
        unit: 'characters',
        advisory: true,
        checkedAt: CHECKED_AT,
        sourceUrl: REDDIT_LIMITS,
      },
      {
        field: 'body',
        value: 40_000,
        unit: 'characters',
        advisory: true,
        checkedAt: CHECKED_AT,
        sourceUrl: REDDIT_LIMITS,
      },
    ],
  },
  tiktok: {
    platform: 'tiktok',
    deepLink: 'https://www.tiktok.com/upload',
    instructions:
      'Téléverser la vidéo attendue, copier la description et les hashtags, vérifier le marquage IA puis publier.',
    checklist: ['Média vertical prêt', 'Sous-titres relus', 'Marquage IA vérifié'],
    textLimits: [
      {
        field: 'description',
        value: 2_200,
        unit: 'utf16_runes',
        advisory: false,
        checkedAt: CHECKED_AT,
        sourceUrl: TIKTOK_DIRECT_POST,
      },
    ],
  },
  youtube: {
    platform: 'youtube',
    deepLink: 'https://studio.youtube.com/',
    instructions:
      'Ouvrir YouTube Studio, téléverser le média, copier le titre et la description, puis publier après relecture.',
    checklist: ['Miniature et média prêts', 'Visibilité choisie', 'Marquage IA vérifié'],
    textLimits: [
      {
        field: 'title',
        value: 100,
        unit: 'characters',
        advisory: false,
        checkedAt: CHECKED_AT,
        sourceUrl: YOUTUBE_VIDEOS,
      },
      {
        field: 'description',
        value: 5_000,
        unit: 'utf8_bytes',
        advisory: false,
        checkedAt: CHECKED_AT,
        sourceUrl: YOUTUBE_VIDEOS,
      },
    ],
  },
};

const TEXT_VALUE: Record<VerifiedTextLimit['field'], (req: PublishRequest) => string> = {
  body: (req) => req.body,
  title: (req) => req.title ?? '',
  description: (req) => req.description ?? '',
};

const MEASURE: Record<VerifiedTextLimit['unit'], (value: string) => number> = {
  characters: (value) => value.length,
  utf16_runes: (value) => [...value].length,
  utf8_bytes: (value) => new TextEncoder().encode(value).length,
};

class ManualConnector implements PlatformConnector {
  readonly platform: PlatformId;
  constructor(private readonly config: ManualConnectorConfig) {
    this.platform = config.platform;
  }

  capabilities(): ConnectorCapabilities {
    const primaryLimit = this.config.textLimits.find((limit) => limit.field !== 'title');
    return {
      directPublish: false,
      draft: false,
      schedule: false,
      analytics: false,
      videoUpload: false,
      imageUpload: false,
      maxTextLength: {
        value: primaryLimit?.value ?? 0,
        advisory: primaryLimit?.advisory ?? true,
        checkedAt: primaryLimit?.checkedAt ?? null,
      },
      textLimits: this.config.textLimits,
      requiresReview: true,
      level: 'C',
    };
  }

  async authenticate(_accountId: string): Promise<void> {}

  async validateContent(req: PublishRequest): Promise<ValidationReport> {
    const spec = contentTargetSpec(req.target);
    const issues: ValidationReport['issues'] = [];
    if (req.platform !== this.platform || spec.platform !== this.platform) {
      issues.push({
        field: 'other',
        severity: 'blocking',
        message: 'La cible ne correspond pas au connecteur choisi.',
      });
    }
    if (req.body.length > spec.bodyMaxChars) {
      issues.push({
        field: 'body',
        severity: 'warning',
        message: `Le texte fait ${req.body.length} caractères ; la limite ${spec.bodyMaxChars} est advisory tant qu’elle n’a pas été revérifiée.`,
        limit: spec.bodyMaxChars,
        actual: req.body.length,
      });
    }
    for (const limit of this.config.textLimits) {
      const actual = MEASURE[limit.unit](TEXT_VALUE[limit.field](req));
      if (actual > limit.value) {
        issues.push({
          field: limit.field,
          severity: limit.advisory ? 'warning' : 'blocking',
          message: `${limit.field} dépasse la limite vérifiée (${actual}/${limit.value}, ${limit.unit}).`,
          limit: limit.value,
          actual,
        });
      }
    }
    return {
      ok: !issues.some((issue) => issue.severity === 'blocking'),
      issues,
      warnings: issues
        .filter((issue) => issue.severity === 'warning')
        .map((issue) => issue.message),
    };
  }

  async createDraft(_req: PublishRequest): Promise<PublishResult> {
    return { outcome: 'manual_required' };
  }
  async publish(_req: PublishRequest): Promise<PublishResult> {
    return { outcome: 'manual_required' };
  }
  async schedule(_req: PublishRequest, _at: Date): Promise<PublishResult> {
    return { outcome: 'manual_required' };
  }
  async fetchMetrics(_remoteId: string, _since: Date): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  async buildManualPackage(req: PublishRequest): Promise<ManualPackage> {
    return {
      platform: this.platform,
      contentVersionId: req.contentVersionId,
      body: req.body,
      title: req.title,
      hook: req.hook,
      description: req.description ?? req.body,
      hashtags: [...req.hashtags],
      mentions: [...req.mentions],
      instructions: this.config.instructions,
      checklist: [...this.config.checklist],
      assets: [...req.assets],
      expectedMedia: EXPECTED_MEDIA[contentTargetSpec(req.target).format],
      deepLink: this.config.deepLink,
    };
  }
}

export const manualConnectors: Readonly<
  Record<'linkedin' | 'reddit' | 'tiktok' | 'youtube', PlatformConnector>
> = Object.fromEntries(
  Object.entries(CONFIGS).map(([key, config]) => [key, new ManualConnector(config)]),
) as unknown as Record<'linkedin' | 'reddit' | 'tiktok' | 'youtube', PlatformConnector>;

export function connectorFor(platform: PlatformId): PlatformConnector | null {
  return platform in manualConnectors
    ? manualConnectors[platform as keyof typeof manualConnectors]
    : null;
}
