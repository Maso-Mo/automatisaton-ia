import { desc, eq, inArray } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  encodeJson,
  parseJsonUnknown,
  uuidv7,
  type StoredRenderPlan,
  type VideoRenderStatus,
} from '@aia/shared';
import type { DatabaseHandle } from '../client';
import { videoRenders } from '../schema';

/**
 * Persistance des **rendus vidéo** (docs/03 §10.3, docs/10 §4.7).
 *
 * Trois propriétés portées par ce module, et par aucun autre :
 *
 * 1. **une seule machine à états**. Les transitions autorisées sont écrites ici,
 *    pas dispersées dans le worker et dans l'API : un rendu ne passe pas de
 *    `completed` à `rendering` parce qu'un handler a oublié de vérifier ;
 *    `completed`, `failed` et `cancelled` sont terminaux.
 * 2. **le plan et les arguments sont conservés** : `edit_plan_json` est l'intention
 *    (écrite à la validation du plan par l'utilisateur), `ffmpeg_args_json` le
 *    résultat de sa compilation (écrit au moment du rendu). Comparer les deux est
 *    ce qui rend un échec explicable — et un rendu rejouable à l'identique.
 * 3. **la reprise ne recrée rien** : reprendre un rendu interrompu consiste à
 *    relire la ligne existante (`interrupted()`) et à relancer le job avec le même
 *    `renderId`. Aucune donnée métier n'est dupliquée.
 */

export interface VideoRenderRecord {
  id: string;
  projectId: string;
  contentItemId: string | null;
  /** La version **exacte** du contenu qui a produit ce rendu. */
  contentVersionId: string;
  /** Les assets source du plan (un seul à l'étape 7 : la vidéo importée). */
  sourceAssetIds: string[];
  outputAssetId: string | null;
  preset: string;
  plan: StoredRenderPlan | null;
  ffmpegArgs: string[];
  ffmpegVersion: string | null;
  status: VideoRenderStatus;
  progress: number;
  durationMs: number | null;
  outputSizeBytes: number | null;
  error: unknown;
  jobId: string | null;
  validatedAt: number | null;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

const TERMINAL: readonly VideoRenderStatus[] = ['completed', 'failed', 'cancelled'];

function decodeStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  const parsed = parseJsonUnknown(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  return parsed.value.filter((entry): entry is string => typeof entry === 'string');
}

function toRecord(row: typeof videoRenders.$inferSelect): VideoRenderRecord {
  const plan = parseJsonUnknown(row.edit_plan_json);
  const error = row.error_json === null ? null : parseJsonUnknown(row.error_json);
  return {
    id: row.id,
    projectId: row.project_id,
    contentItemId: row.content_item_id,
    contentVersionId: row.content_version_id,
    sourceAssetIds: decodeStringArray(row.source_asset_ids_json),
    outputAssetId: row.output_asset_id,
    preset: row.preset,
    plan: plan.ok ? (plan.value as StoredRenderPlan) : null,
    ffmpegArgs: decodeStringArray(row.ffmpeg_args_json),
    ffmpegVersion: row.ffmpeg_version,
    status: row.status as VideoRenderStatus,
    progress: row.progress,
    durationMs: row.duration_ms,
    outputSizeBytes: row.output_size_bytes,
    error: error !== null && error.ok ? error.value : null,
    jobId: row.job_id,
    validatedAt: row.validated_at,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createVideoRenderStore(handle: DatabaseHandle, nowMs: () => number) {
  const newId = (): string => uuidv7(nowMs());

  function get(id: string): VideoRenderRecord | null {
    const row = handle.db.select().from(videoRenders).where(eq(videoRenders.id, id)).get();
    return row ? toRecord(row) : null;
  }

  /** Transition contrôlée : c'est ici que la machine à états est appliquée. */
  function transition(
    id: string,
    from: readonly VideoRenderStatus[],
    patch: Partial<typeof videoRenders.$inferInsert>,
  ): VideoRenderRecord {
    const current = getOrThrow(id);
    if (!from.includes(current.status)) {
      throw new ConflictError(
        `Transition de rendu refusée : ${current.status} → ${String(patch.status ?? current.status)}.`,
        {
          code: 'VIDEO_RENDER_TRANSITION',
          details: { renderId: id, from: current.status, to: patch.status ?? current.status },
        },
      );
    }
    handle.db.update(videoRenders).set(patch).where(eq(videoRenders.id, id)).run();
    return get(id)!;
  }

  function getOrThrow(id: string): VideoRenderRecord {
    const record = get(id);
    if (!record) {
      throw new NotFoundError(`Rendu vidéo introuvable : ${id}`, {
        code: 'VIDEO_RENDER_NOT_FOUND',
      });
    }
    return record;
  }

  return {
    /**
     * Crée un rendu **en attente**. Le plan est déjà celui que l'utilisateur a
     * validé : c'est la ligne de vérité du rendu, et le job ne portera que son
     * identifiant (docs/10 §4.7).
     */
    create(input: {
      id?: string;
      projectId: string;
      contentItemId: string | null;
      contentVersionId: string;
      sourceAssetIds: readonly string[];
      preset: string;
      plan: StoredRenderPlan;
    }): VideoRenderRecord {
      const id = input.id ?? newId();
      const now = nowMs();
      handle.db
        .insert(videoRenders)
        .values({
          id,
          project_id: input.projectId,
          content_item_id: input.contentItemId,
          content_version_id: input.contentVersionId,
          source_asset_ids_json: encodeJson([...input.sourceAssetIds]),
          preset: input.preset,
          edit_plan_json: encodeJson(input.plan),
          // Aucun argument n'existe encore : le rendu n'a pas encore été compilé.
          ffmpeg_args_json: encodeJson([]),
          status: 'queued',
          progress: 0,
          requested_at: now,
        })
        .run();
      return get(id)!;
    },

    get,
    getOrThrow,

    findByJobId(jobId: string): VideoRenderRecord | null {
      const row = handle.db.select().from(videoRenders).where(eq(videoRenders.job_id, jobId)).get();
      return row ? toRecord(row) : null;
    },

    /** Le job qui exécute ce rendu : c'est ce qui permet de suivre sa progression. */
    attachJob(id: string, jobId: string): VideoRenderRecord {
      const current = getOrThrow(id);
      if (current.jobId !== null && current.jobId !== jobId) {
        throw new ConflictError('Ce rendu est déjà rattaché à un autre job.', {
          code: 'VIDEO_RENDER_JOB_CONFLICT',
          details: { renderId: id, jobId: current.jobId },
        });
      }
      handle.db.update(videoRenders).set({ job_id: jobId }).where(eq(videoRenders.id, id)).run();
      return get(id)!;
    },

    /**
     * Début de la préparation : lecture de la source, écriture des sous-titres.
     *
     * `failed` est accepté en entrée, et c'est voulu : le statut décrit la
     * **dernière tentative**, pas une condamnation. Une reprise légitime (la file
     * qui réessaie une erreur transitoire, ou l'utilisateur qui relance) doit
     * pouvoir ré-armer la ligne — sinon une première coupure condamnerait le rendu.
     */
    markPreparing(id: string): VideoRenderRecord {
      return transition(id, ['queued', 'preparing', 'rendering', 'failed'], {
        status: 'preparing',
        started_at: nowMs(),
        error_json: null,
      });
    },

    /** Début de l'encodage FFmpeg. */
    markRendering(id: string): VideoRenderRecord {
      return transition(id, ['preparing', 'rendering'], { status: 'rendering' });
    },
    /**
     * La progression ne recule jamais : FFmpeg écrit l'horodatage de sortie, qui
     * peut repartir en arrière avec les images B ; l'écran doit rester monotone.
     */
    setProgress(id: string, progress: number): VideoRenderRecord {
      const clamped = Math.min(100, Math.max(0, Math.round(progress)));
      const current = getOrThrow(id);
      if (clamped <= current.progress) return current;
      handle.db
        .update(videoRenders)
        .set({ progress: clamped })
        .where(eq(videoRenders.id, id))
        .run();
      return get(id)!;
    },

    /** Les arguments **exacts** compilés depuis le plan : conservés avant l'exécution. */
    recordCompiledArgs(
      id: string,
      args: readonly string[],
      ffmpegVersion: string | null,
    ): VideoRenderRecord {
      handle.db
        .update(videoRenders)
        .set({ ffmpeg_args_json: encodeJson([...args]), ffmpeg_version: ffmpegVersion })
        .where(eq(videoRenders.id, id))
        .run();
      return getOrThrow(id);
    },

    complete(
      id: string,
      input: {
        outputAssetId: string;
        durationMs: number | null;
        outputSizeBytes: number | null;
        progress?: number;
      },
    ): VideoRenderRecord {
      return transition(id, ['preparing', 'rendering'], {
        status: 'completed',
        output_asset_id: input.outputAssetId,
        duration_ms: input.durationMs,
        output_size_bytes: input.outputSizeBytes,
        progress: input.progress ?? 100,
        finished_at: nowMs(),
        error_json: null,
      });
    },

    /**
     * Échec d'une tentative. Le motif est conservé : c'est ce que l'écran affiche,
     * et c'est ce qui rend un échec **explicable** au lieu de muet (docs/10 §4.7).
     * Une tentative suivante repasse par `markPreparing`, qui efface ce motif.
     */
    fail(id: string, error: unknown): VideoRenderRecord {
      return transition(id, ['queued', 'preparing', 'rendering', 'failed'], {
        status: 'failed',
        error_json: encodeJson(error),
        finished_at: nowMs(),
      });
    },

    cancel(id: string): VideoRenderRecord {
      return transition(id, ['queued', 'preparing', 'rendering'], {
        status: 'cancelled',
        finished_at: nowMs(),
      });
    },

    /**
     * Remet un rendu **en attente** : c'est ce que fait « relancer » et ce que
     * fait la reprise d'un rendu interrompu. Le plan, la source et la version de
     * contenu sont **conservés** — rien de métier n'est recréé (§13).
     */
    requeue(id: string): VideoRenderRecord {
      return transition(id, ['queued', 'preparing', 'rendering', 'failed', 'cancelled'], {
        status: 'queued',
        progress: 0,
        error_json: null,
        job_id: null,
        started_at: null,
        finished_at: null,
      });
    },

    /**
     * Supprime un rendu qui n'a **jamais** produit de fichier (le job n'a pas pu
     * être créé). Un rendu terminé n'est jamais supprimé ici : il porte un asset
     * de sortie, donc une preuve.
     */
    remove(id: string): void {
      const current = getOrThrow(id);
      if (current.outputAssetId !== null) {
        throw new ConflictError('Un rendu qui a produit un fichier ne se supprime pas.', {
          code: 'VIDEO_RENDER_HAS_OUTPUT',
          details: { renderId: id, outputAssetId: current.outputAssetId },
        });
      }
      handle.db.delete(videoRenders).where(eq(videoRenders.id, id)).run();
    },

    /** Validation humaine du rendu : la seule trace que quelqu'un l'a regardé. */
    validate(id: string): VideoRenderRecord {
      const current = getOrThrow(id);
      if (current.status !== 'completed') {
        throw new ConflictError('Un rendu non terminé ne peut pas être validé.', {
          code: 'VIDEO_RENDER_NOT_COMPLETED',
          details: { renderId: id, status: current.status },
        });
      }
      handle.db
        .update(videoRenders)
        .set({ validated_at: nowMs() })
        .where(eq(videoRenders.id, id))
        .run();
      return get(id)!;
    },

    listByProject(projectId: string, limit = 20): VideoRenderRecord[] {
      return handle.db
        .select()
        .from(videoRenders)
        .where(eq(videoRenders.project_id, projectId))
        .orderBy(desc(videoRenders.requested_at))
        .limit(limit)
        .all()
        .map(toRecord);
    },

    listByContentItem(contentItemId: string): VideoRenderRecord[] {
      return handle.db
        .select()
        .from(videoRenders)
        .where(eq(videoRenders.content_item_id, contentItemId))
        .orderBy(desc(videoRenders.requested_at))
        .all()
        .map(toRecord);
    },

    listByContentVersion(contentVersionId: string): VideoRenderRecord[] {
      return handle.db
        .select()
        .from(videoRenders)
        .where(eq(videoRenders.content_version_id, contentVersionId))
        .orderBy(desc(videoRenders.requested_at))
        .all()
        .map(toRecord);
    },

    /**
     * Les rendus **interrompus** : un worker est mort, ou la machine s'est éteinte.
     * Ils gardent leur plan, leur source et leur version de contenu ; seul le
     * processus d'encodage est à relancer (§13).
     */
    interrupted(limit = 50): VideoRenderRecord[] {
      return handle.db
        .select()
        .from(videoRenders)
        .where(inArray(videoRenders.status, ['preparing', 'rendering']))
        .orderBy(videoRenders.started_at)
        .limit(limit)
        .all()
        .map(toRecord);
    },

    /** Nombre total de rendus : sert au diagnostic et aux tests. */
    count(): number {
      return handle.db.select().from(videoRenders).all().length;
    },

    /** Les états terminaux, exposés pour que l'API n'en recopie pas la liste. */
    isTerminal(status: VideoRenderStatus): boolean {
      return TERMINAL.includes(status);
    },
  };
}

export type VideoRenderStore = ReturnType<typeof createVideoRenderStore>;
