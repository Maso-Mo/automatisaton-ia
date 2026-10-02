import type { VideoAssetView, VideoCapabilitiesView, VideoPlanView } from '../../api/client';

/**
 * Ce que l'écran de montage calcule **sans le serveur** : la mise en forme d'une
 * durée, la lecture d'un timecode saisi à la main, et la description d'une vidéo.
 *
 * Ce module est pur, donc testable sans navigateur (même découpage que
 * `editorial/state.ts`, docs/09 §6.2). Une règle est tenue ici : **il ne remplace
 * jamais la validation du serveur**. Un plan refusé par l'API est refusé par
 * l'API ; en attendant, l'écran vérifie seulement ce qu'il peut vérifier pour
 * éviter un aller-retour inutile, et il dit ce qu'il ne sait pas.
 */

/** `m:ss.mmm` — la même convention que les journaux du worker. */
export function formatMs(milliseconds: number | null): string {
  if (milliseconds === null) return '—';
  const clamped = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1_000);
  const millis = clamped % 1_000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Lecture d'un timecode saisi à la main : `90`, `12.5`, `1:30`, `0:12.500`.
 *
 * Les trois formes sont acceptées parce que les trois se rencontrent devant une
 * timeline : des secondes, des secondes décimales, et un `m:ss`. Un format
 * ambigu (`1:2:3`) est refusé plutôt que deviné — se tromper de trois minutes
 * coûterait un rendu entier.
 */
export function parseTimecode(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed.length === 0) return null;

  const parts = trimmed.split(':');
  if (parts.length > 2) return null;

  const secondsPart = parts[parts.length - 1] ?? '';
  if (!/^\d+(\.\d{1,3})?$/.test(secondsPart)) return null;
  const seconds = Number(secondsPart);

  if (parts.length === 1) return Math.round(seconds * 1_000);

  const minutesPart = parts[0] ?? '';
  if (!/^\d+$/.test(minutesPart)) return null;
  return Math.round((Number(minutesPart) * 60 + seconds) * 1_000);
}

/** Le timecode **éditable** : `0:12.5`, jamais un nombre de millisecondes. */
export function formatTimecodeInput(milliseconds: number): string {
  const clamped = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = (clamped % 60_000) / 1_000;
  return `${minutes}:${seconds.toFixed(1)}`;
}

export interface PlanDraft {
  startMs: number;
  endMs: number;
}

export type PlanDraftResult = { ok: true; plan: PlanDraft } | { ok: false; error: string };

/**
 * Le contrôle **local** du plan : bornes saisies contre la durée de la vidéo et
 * la durée maximale d'extrait servies par l'API.
 *
 * C'est un confort, pas une autorité : le serveur revalide avec les vraies
 * bornes (`validateRenderPlan`) avant de créer le job, et l'écran affiche son
 * refus tel quel. Ce contrôle évite simplement de créer un job pour rien.
 */
export function buildPlanDraft(
  startText: string,
  endText: string,
  bounds: { sourceDurationMs: number; maxClipMs: number },
): PlanDraftResult {
  const startMs = parseTimecode(startText);
  const endMs = parseTimecode(endText);
  if (startMs === null)
    return { ok: false, error: 'Début illisible : attendu « 12 », « 12.5 » ou « 1:20 ».' };
  if (endMs === null)
    return { ok: false, error: 'Fin illisible : attendu « 12 », « 12.5 » ou « 1:20 ».' };
  if (endMs <= startMs) return { ok: false, error: 'La fin doit être postérieure au début.' };
  if (endMs > bounds.sourceDurationMs) {
    return {
      ok: false,
      error: `La fin dépasse la durée de la vidéo (${formatMs(bounds.sourceDurationMs)}).`,
    };
  }
  if (endMs - startMs > bounds.maxClipMs) {
    return {
      ok: false,
      error: `Extrait trop long : ${formatMs(endMs - startMs)} (maximum ${formatMs(bounds.maxClipMs)}).`,
    };
  }
  return { ok: true, plan: { startMs, endMs } };
}

/** Une ligne de description d'une vidéo importée : tout vient d'une mesure. */
export function describeSource(asset: VideoAssetView): string {
  const parts: string[] = [];
  parts.push(
    asset.width !== null && asset.height !== null
      ? `${asset.width}×${asset.height}`
      : 'résolution inconnue',
  );
  parts.push(formatMs(asset.durationMs));
  parts.push(asset.codec ?? 'codec inconnu');
  parts.push(asset.hasAudio === true ? 'avec audio' : 'sans audio');
  return parts.join(' · ');
}

/** Ce que l'écran peut dire d'un plan proposé, sans le réécrire. */
export function planSummary(plan: VideoPlanView): string {
  return `${formatMs(plan.plan.startMs)} → ${formatMs(plan.plan.endMs)} (${formatMs(
    plan.plan.endMs - plan.plan.startMs,
  )})`;
}

/**
 * Le refus d'avancer, **dit avant** de cliquer : une vidéo sans transcription ne
 * peut pas être sous-titrée, donc pas montée en short (docs/05 §6.2).
 */
export function transcriptionBlocker(asset: VideoAssetView): string | null {
  if (asset.hasAudio === false) {
    return 'Cette vidéo n’a pas de piste audio : elle ne peut pas être transcrite, donc pas sous-titrée.';
  }
  if (!asset.transcript.available) {
    return 'Transcrire la vidéo avant de proposer un montage : les sous-titres en viennent.';
  }
  if (asset.transcript.segments === 0) {
    return 'La transcription ne contient aucun segment horodaté : aucun sous-titre n’est possible.';
  }
  return null;
}

/** Le libellé d'un statut de rendu vient de l'API, jamais d'une table locale. */
export function statusLabel(
  capabilities: VideoCapabilitiesView | undefined,
  status: string,
): string {
  return capabilities?.renderStatuses.find((entry) => entry.value === status)?.label ?? status;
}
