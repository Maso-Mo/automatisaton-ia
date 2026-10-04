export type HookType =
  'question' | 'result_first' | 'contradiction' | 'problem' | 'promise' | 'affirmation';
export type CtaType = 'none' | 'question' | 'follow' | 'comment' | 'link' | 'share' | 'save';

export interface ContentFeatures {
  hookType: HookType;
  wordCount: number;
  sentenceCount: number;
  averageSentenceWordsX100: number;
  structure:
    'problem_solution' | 'result_explanation' | 'storytelling' | 'list' | 'demonstration' | 'other';
  ctaType: CtaType;
  technicalLevel: 'accessible' | 'intermediate' | 'advanced';
  lengthBucket: 'very_short' | 'short' | 'medium' | 'long';
  hasVideo: boolean;
  hasSubtitles: boolean | null;
  durationMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  durationBucket: 'under_15s' | '15_30s' | '30_60s' | 'over_60s' | 'unknown';
  sceneChangeCount: number | null;
  averageSceneIntervalMs: number | null;
  visualPace: 'fast' | 'medium' | 'slow' | 'unknown';
  speechDensityX100: number | null;
  averagePhraseDurationMs: number | null;
}

function normalized(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function extractContentFeatures(input: {
  title?: string | null;
  hook?: string | null;
  body: string;
  durationMs?: number | null;
  fps?: number | null;
  width?: number | null;
  height?: number | null;
  subtitleGenerated?: boolean | null;
  transcriptSegments?: readonly { startMs: number; endMs: number; text: string }[];
  sceneChangesMs?: readonly number[];
}): ContentFeatures {
  const hook = normalized(input.hook || input.title || input.body.split(/[.!?]/)[0] || '');
  const body = normalized(input.body);
  const words = input.body.trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  const sentences = input.body
    .split(/[.!?]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const hookType: HookType = hook.includes('?')
    ? 'question'
    : /voici|resultat|j'ai (fait|obtenu)|avant.*apres/.test(hook)
      ? 'result_first'
      : /pourtant|contrairement|mais/.test(hook)
        ? 'contradiction'
        : /probleme|erreur|bloqu/.test(hook)
          ? 'problem'
          : /comment|vous allez|permet de/.test(hook)
            ? 'promise'
            : 'affirmation';
  const structure: ContentFeatures['structure'] = /probleme[\s\S]*(solution|resolu)/.test(body)
    ? 'problem_solution'
    : /(resultat|voici)[\s\S]*(pourquoi|comment|explication)/.test(body)
      ? 'result_explanation'
      : /\b(etape|1\.|2\.|3\.|premier|ensuite|enfin)\b/.test(body)
        ? 'list'
        : /demo|demonstration|regardez|ecran/.test(body)
          ? 'demonstration'
          : /un jour|j'ai|mon experience|nous avons/.test(body)
            ? 'storytelling'
            : 'other';
  const ctaType: CtaType = /qu'en pensez|et vous|\?$/.test(body)
    ? 'question'
    : /abonne|follow/.test(body)
      ? 'follow'
      : /commentaire|commente/.test(body)
        ? 'comment'
        : /lien|http|bio/.test(body)
          ? 'link'
          : /partage/.test(body)
            ? 'share'
            : /sauvegarde|enregistre/.test(body)
              ? 'save'
              : 'none';
  const technicalTerms = (
    body.match(/\b(api|typescript|javascript|react|sql|docker|llm|json|git)\b/g) ?? []
  ).length;
  const technicalLevel =
    technicalTerms >= 6 ? 'advanced' : technicalTerms >= 2 ? 'intermediate' : 'accessible';
  const segments = input.transcriptSegments ?? [];
  const speechMs = segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
    0,
  );
  const sceneChanges = input.sceneChangesMs ?? [];
  const averageSceneIntervalMs =
    sceneChanges.length > 1
      ? Math.round(
          (sceneChanges[sceneChanges.length - 1]! - sceneChanges[0]!) / (sceneChanges.length - 1),
        )
      : null;
  return {
    hookType,
    wordCount: words.length,
    sentenceCount: sentences.length,
    averageSentenceWordsX100:
      sentences.length === 0 ? 0 : Math.round((words.length / sentences.length) * 100),
    structure,
    ctaType,
    technicalLevel,
    lengthBucket:
      words.length < 40
        ? 'very_short'
        : words.length < 120
          ? 'short'
          : words.length < 300
            ? 'medium'
            : 'long',
    hasVideo: input.durationMs !== null && input.durationMs !== undefined,
    hasSubtitles: input.subtitleGenerated ?? null,
    durationMs: input.durationMs ?? null,
    fps: input.fps ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    durationBucket:
      input.durationMs === null || input.durationMs === undefined
        ? 'unknown'
        : input.durationMs < 15_000
          ? 'under_15s'
          : input.durationMs < 30_000
            ? '15_30s'
            : input.durationMs < 60_000
              ? '30_60s'
              : 'over_60s',
    sceneChangeCount: sceneChanges.length > 0 ? sceneChanges.length : null,
    averageSceneIntervalMs,
    visualPace:
      averageSceneIntervalMs === null
        ? 'unknown'
        : averageSceneIntervalMs < 2_500
          ? 'fast'
          : averageSceneIntervalMs < 5_000
            ? 'medium'
            : 'slow',
    speechDensityX100:
      input.durationMs && input.durationMs > 0
        ? Math.round((speechMs / input.durationMs) * 100)
        : null,
    averagePhraseDurationMs: segments.length > 0 ? Math.round(speechMs / segments.length) : null,
  };
}

export const FEATURE_DIMENSIONS = [
  ['hook_type', 'hookType'],
  ['structure', 'structure'],
  ['length', 'lengthBucket'],
  ['cta_type', 'ctaType'],
  ['technical_level', 'technicalLevel'],
  ['has_video', 'hasVideo'],
  ['has_subtitles', 'hasSubtitles'],
  ['duration', 'durationBucket'],
  ['visual_pace', 'visualPace'],
] as const;
