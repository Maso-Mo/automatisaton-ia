import type {
  ContentBundleView,
  ContentNoteView,
  ContentVersionView,
  EditorialTargetSpec,
  EditorialVocabulary,
  PublicJob,
} from '../../api/client';

/**
 * Logique **pure** de l'écran de revue (étape 5).
 *
 * Tout ce qui décide de ce que l'utilisateur voit ou peut faire vit ici, hors de
 * React : dérivation d'une carte par plateforme, libellé de version, compteurs de
 * caractères face au budget de la cible, explication d'un refus (« l'approbation
 * est impossible parce que… ») et suivi d'un job.
 *
 * **Aucune règle métier n'est réécrite ici** : états, transitions et plafonds
 * viennent du vocabulaire servi par l'API. Ces fonctions répondent à « que puis-je
 * afficher ? », jamais à « qu'est-ce qui est permis ? » — le refus définitif
 * appartient au domaine (`packages/core`), et l'écran ne fait que l'anticiper
 * pour éviter à l'utilisateur un aller-retour inutile.
 */

/** Une carte de revue : **une** plateforme, **une** version courante. */
export interface EditorialCard {
  itemId: string;
  target: string;
  platform: string;
  /** En-tête de section : « LinkedIn », « YouTube Short »… */
  sectionLabel: string;
  targetLabel: string;
  state: string;
  stateLabel: string;
  /** `archived` **et** motivé par une décision : c'est un rejet, pas un rangement. */
  rejected: boolean;
  rejectionReason: string | null;
  approved: boolean;
  /** Le contenu a été ouvert en relecture : sans cela, l'approbation est refusée. */
  inReview: boolean;
  versionNumber: number | null;
  versionLabel: string;
  generationLabel: string | null;
  approvedVersionNumber: number | null;
  body: string;
  title: string | null;
  hook: string | null;
  hashtags: string[];
  charCount: number;
  charBudget: number;
  charRatio: number;
  overflowChars: number;
  editRatio: number | null;
  regeneratedCount: number;
  regenerationsLeft: number;
  notes: EditorialNote[];
  warnings: EditorialNote[];
  blockingIssues: string[];
  qualityScore: number | null;
  updatedAt: number;
  canApprove: boolean;
  approvalBlockedReason: string | null;
  canRegenerate: boolean;
  regenerateBlockedReason: string | null;
  canEdit: boolean;
  editBlockedReason: string | null;
  canReject: boolean;
}

export interface EditorialNote {
  id: string;
  type: string;
  typeLabel: string;
  severity: string;
  severityLabel: string;
  message: string;
  anchorText: string | null;
  author: string;
  resolved: boolean;
  createdAt: number;
  tone: 'danger' | 'warning' | 'info';
}

export interface EditorialSection {
  key: string;
  label: string;
  cards: EditorialCard[];
}

/** Une version telle qu'elle est proposée dans la liste « versions précédentes ». */
export interface VersionOption {
  id: string;
  versionNumber: number;
  label: string;
  generation: string;
  generationLabel: string;
  isCurrent: boolean;
  isApproved: boolean;
  createdAt: number;
  charCount: number | null;
  wordCount: number | null;
}

const NOTE_TONES: Record<string, EditorialNote['tone']> = {
  erreur: 'danger',
  critique: 'danger',
  warning: 'warning',
  suggestion: 'info',
  decision: 'info',
};

/**
 * Résout un libellé dans une liste servie par le vocabulaire de l'API.
 *
 * Le repli est le code lui-même, jamais une chaîne vide : si le domaine gagne une
 * valeur que l'écran ne connaît pas encore, l'utilisateur lit `publication_ambigue`
 * — moche mais exact — au lieu d'un blanc qui ferait croire à une donnée absente.
 */
export function labelOf(
  entries: ReadonlyArray<{ value: string; label: string }>,
  value: string | null,
  fallback = '—',
): string {
  if (value === null) return fallback;
  return entries.find((entry) => entry.value === value)?.label ?? value;
}

function specOf(vocabulary: EditorialVocabulary, target: string): EditorialTargetSpec | undefined {
  return vocabulary.targets.find((spec) => spec.key === target);
}

/** `v3 · Régénération IA` : le numéro seul ne dit pas ce qui a produit le texte. */
export function versionLabel(
  versionNumber: number | null,
  generation: string | null,
  vocabulary: EditorialVocabulary,
): string {
  if (versionNumber === null) return 'aucune version';
  const suffix = generation ? labelOf(vocabulary.generations, generation) : null;
  return suffix ? `v${versionNumber} · ${suffix}` : `v${versionNumber}`;
}

export function noteView(note: ContentNoteView, vocabulary: EditorialVocabulary): EditorialNote {
  return {
    id: note.id,
    type: note.noteType,
    typeLabel: labelOf(vocabulary.noteTypes, note.noteType),
    severity: note.severity,
    severityLabel: labelOf(vocabulary.noteSeverities, note.severity),
    message: note.message,
    anchorText: note.anchorText,
    author: note.author,
    resolved: note.resolved,
    createdAt: note.createdAt,
    tone: NOTE_TONES[note.noteType] ?? 'info',
  };
}

/** Le motif d'un rejet : une décision **motivée** écrite par l'utilisateur. */
export function rejectionReason(notes: readonly EditorialNote[]): string | null {
  const decision = notes.find((note) => note.type === 'decision' && note.message.trim().length > 0);
  return decision?.message ?? null;
}

function transitionsOf(vocabulary: EditorialVocabulary, state: string): string[] {
  return vocabulary.contentStates.find((entry) => entry.value === state)?.next ?? [];
}

/**
 * Construit la carte d'une plateforme.
 *
 * Les contraintes d'affichage reprennent **exactement** les transitions servies
 * par l'API : si le domaine autorisait un jour `generated → approved`, le bouton
 * s'activerait tout seul. L'inverse est vrai aussi — c'est ce qui rend impossible
 * d'approuver un contenu rejeté, ou un contenu jamais relu.
 */
export function buildCard(
  bundle: ContentBundleView,
  vocabulary: EditorialVocabulary,
  options: { blockingIssues?: readonly string[] } = {},
): EditorialCard {
  const { item, version } = bundle;
  const spec = specOf(vocabulary, item.target);
  const notes = bundle.notes
    .filter((note) => note.contentVersionId === item.currentVersionId)
    .map((note) => noteView(note, vocabulary));
  const stateLabel = labelOf(vocabulary.contentStates, item.state);
  const allowed = transitionsOf(vocabulary, item.state);
  const reason = rejectionReason(notes);
  const rejected = item.state === 'archived' && reason !== null;
  const inReview = item.state === 'in_review' || item.state === 'editing';
  const charBudget = spec?.bodyMaxChars ?? 0;
  const charCount = version?.charCount ?? version?.body.length ?? 0;
  const regenerationLimit = vocabulary.limits.maxRegenerationsPerItem;
  const regenerationsLeft = Math.max(0, regenerationLimit - item.regeneratedCount);
  // Un état **terminal** (aucun suivant au catalogue) est un contenu archivé :
  // c'est exactement ce que refuse `assertRegenerationAllowed` dans le domaine
  // (`archived`, plus le plafond de régénérations), et ce que refuse `editContent`.
  // On le lit donc dans les transitions servies par l'API plutôt que de réécrire
  // la règle ici.
  const terminal = allowed.length === 0;
  const reviewsComplete = ['critic', 'fact_checker'].every((author) =>
    notes.some((note) => note.author === author),
  );

  // L'ordre des raisons compte : la plus spécifique d'abord, pour que le message
  // affiché soit celui de la situation réelle.
  const approvalBlockedReason = !allowed.includes('approved')
    ? rejected
      ? 'Ce contenu a été rejeté : il ne s’approuve plus. Relancer une génération depuis l’angle si tu changes d’avis.'
      : item.state === 'approved'
        ? 'Version déjà approuvée — la régénérer ou la modifier créera une nouvelle version à valider.'
        : 'Ouvrir la relecture de ce contenu avant de l’approuver : c’est l’ouverture qui l’autorise.'
    : item.currentVersionId === null
      ? 'Aucune version à approuver : générer le contenu d’abord.'
      : !reviewsComplete
        ? 'Relancer les contrôles critic et fact checker sur cette version avant de l’approuver.'
        : null;

  const regenerateBlockedReason = terminal
    ? 'Ce contenu est archivé : la régénération est fermée, les versions existantes restent lisibles.'
    : regenerationsLeft === 0
      ? `Plafond de ${regenerationLimit} régénérations atteint pour ce contenu : modifier le texte à la main, ou revoir l’angle.`
      : null;

  return {
    itemId: item.id,
    target: item.target,
    platform: item.platform,
    sectionLabel: spec?.sectionLabel ?? item.platform,
    targetLabel: spec?.label ?? item.target,
    state: item.state,
    stateLabel,
    rejected,
    rejectionReason: reason,
    approved: item.state === 'approved' && item.approvedVersionId === item.currentVersionId,
    inReview,
    versionNumber: version?.versionNumber ?? null,
    versionLabel: versionLabel(
      version?.versionNumber ?? null,
      version?.generation ?? null,
      vocabulary,
    ),
    generationLabel: version ? labelOf(vocabulary.generations, version.generation) : null,
    approvedVersionNumber:
      item.approvedVersionId === null ? null : (version?.versionNumber ?? null),
    body: version?.body ?? '',
    title: version?.title ?? item.title ?? null,
    hook: version?.hook ?? null,
    hashtags: version ? [...version.hashtags] : [],
    charCount,
    charBudget,
    charRatio: charBudget > 0 ? charCount / charBudget : 0,
    overflowChars: charBudget > 0 ? Math.max(0, charCount - charBudget) : 0,
    editRatio: item.editRatio,
    regeneratedCount: item.regeneratedCount,
    regenerationsLeft,
    notes,
    warnings: notes.filter((note) => note.tone === 'warning'),
    blockingIssues: [...(options.blockingIssues ?? [])],
    qualityScore: version?.qualityScore ?? null,
    updatedAt: item.updatedAt,
    canApprove: approvalBlockedReason === null,
    approvalBlockedReason,
    canRegenerate: regenerateBlockedReason === null,
    regenerateBlockedReason,
    canEdit: !terminal,
    editBlockedReason: terminal ? 'Ce contenu est archivé : l’édition manuelle est fermée.' : null,
    canReject: !terminal,
  };
}

/** Les cartes, dans l'ordre des cibles servi par le vocabulaire — jamais l'ordre d'arrivée. */
export function buildCards(
  bundles: readonly ContentBundleView[],
  vocabulary: EditorialVocabulary,
  issues: Readonly<Record<string, readonly string[]>> = {},
): EditorialCard[] {
  const rank = new Map(vocabulary.targets.map((spec, index) => [spec.key, index]));
  return bundles
    .map((bundle) =>
      buildCard(bundle, vocabulary, { blockingIssues: issues[bundle.item.id] ?? [] }),
    )
    .sort(
      (left, right) =>
        (rank.get(left.target) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.target) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * Un **écran par plateforme** : cinq sections nommées, dans l'ordre du catalogue.
 * Une cible sans contenu garde sa section vide — « pas encore généré » est une
 * information, une section absente serait un oubli.
 */
export function groupBySection(
  cards: readonly EditorialCard[],
  vocabulary: EditorialVocabulary,
): EditorialSection[] {
  return vocabulary.targets.map((spec) => ({
    key: spec.key,
    label: spec.sectionLabel,
    cards: cards.filter((card) => card.target === spec.key),
  }));
}

/** Résumé d'un lot : ce que l'utilisateur veut savoir sans ouvrir cinq cartes. */
export function reviewSummary(cards: readonly EditorialCard[]): {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  withWarnings: number;
} {
  return {
    total: cards.length,
    approved: cards.filter((card) => card.approved).length,
    rejected: cards.filter((card) => card.rejected).length,
    pending: cards.filter((card) => !card.approved && !card.rejected).length,
    withWarnings: cards.filter((card) => card.warnings.length + card.blockingIssues.length > 0)
      .length,
  };
}

/** L'historique, du plus récent au plus ancien, avec les deux versions repères. */
export function versionOptions(
  versions: readonly ContentVersionView[],
  currentVersionId: string | null,
  approvedVersionId: string | null,
  vocabulary: EditorialVocabulary,
): VersionOption[] {
  return [...versions]
    .sort((left, right) => right.versionNumber - left.versionNumber)
    .map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      label: versionLabel(version.versionNumber, version.generation, vocabulary),
      generation: version.generation,
      generationLabel: labelOf(vocabulary.generations, version.generation),
      isCurrent: version.id === currentVersionId,
      isApproved: version.id === approvedVersionId,
      createdAt: version.createdAt,
      charCount: version.charCount,
      wordCount: version.wordCount,
    }));
}

/** Les deux textes à regarder côte à côte : ce qui a été approuvé, ce qu'il y a maintenant. */
export function compareWithApproved(
  versions: readonly ContentVersionView[],
  currentVersionId: string | null,
  approvedVersionId: string | null,
): { approved: ContentVersionView | null; current: ContentVersionView | null } {
  return {
    approved: versions.find((version) => version.id === approvedVersionId) ?? null,
    current: versions.find((version) => version.id === currentVersionId) ?? null,
  };
}

// --- Suivi d'un job (SSE) --------------------------------------------------

export interface JobProgress {
  jobId: string | null;
  status: string;
  statusLabel: string;
  progress: number;
  step: string | null;
  message: string;
  costMicroUsd: number;
  error: string | null;
  closed: boolean;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: 'En file d’attente',
  running: 'En cours',
  completed: 'Terminé',
  failed: 'Échec',
  dead: 'Abandonné après tentatives',
  cancelled: 'Annulé',
};

const JOB_STEP_LABELS: Record<string, string> = {
  build_context: 'Assemblage du contexte',
  write_initial: 'Rédaction par le modèle',
  write_retry: 'Reprise après refus du domaine',
  validate_shapes: 'Contrôle de forme du lot',
  record_versions: 'Enregistrement des versions',
  record_failed: 'Échec non rattrapé',
};

export function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABELS[status] ?? status;
}

export function jobStepLabel(step: string | null): string | null {
  if (step === null) return null;
  return JOB_STEP_LABELS[step] ?? step;
}

export function isTerminalJob(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'dead'].includes(status);
}

/** `error_json` est du JSON libre : on n'affiche jamais `[object Object]`. */
export function jobError(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
    const code = (error as { code?: unknown }).code;
    return describeApiError({ code }, 'Le job a échoué sans message.');
  }
  return String(error);
}

export function initialJobProgress(job: PublicJob): JobProgress {
  return {
    jobId: job.id,
    status: job.status,
    statusLabel: jobStatusLabel(job.status),
    progress: job.progress,
    step: job.currentStep,
    message: '',
    costMicroUsd: job.costMicroUsd,
    error: jobError(job.error),
    closed: isTerminalJob(job.status),
  };
}

export type JobStreamMessage =
  | { kind: 'snapshot'; job: PublicJob }
  | {
      kind: 'event';
      event: {
        level?: string;
        step?: string | null;
        message?: string;
        progress?: number;
      };
    }
  | { kind: 'done'; job: PublicJob }
  | { kind: 'closed'; reason?: string };

/**
 * Applique un message du flux `GET /events/jobs/:id`.
 *
 * Le flux envoie `snapshot` (état complet), puis `job_event` (incréments), puis
 * `done` (état terminal). Le réducteur est **monotone** : la progression ne
 * recule jamais et un message est conservé jusqu'au suivant — sinon un événement
 * sans `progress` ferait sauter la barre à zéro en plein milieu.
 */
export function applyJobProgress(state: JobProgress, message: JobStreamMessage): JobProgress {
  switch (message.kind) {
    case 'snapshot':
    case 'done': {
      const fresh = initialJobProgress(message.job);
      return {
        ...fresh,
        progress: Math.max(state.progress, fresh.progress),
        message: fresh.message || state.message,
        closed: message.kind === 'done' ? true : fresh.closed,
      };
    }
    case 'event':
      return {
        ...state,
        step: message.event.step ?? state.step,
        message: message.event.message ?? state.message,
        progress:
          typeof message.event.progress === 'number'
            ? Math.max(state.progress, message.event.progress)
            : state.progress,
      };
    case 'closed':
      return {
        ...state,
        closed: true,
        message: state.message || message.reason || 'Flux interrompu.',
      };
  }
}

// --- Erreurs d'API ---------------------------------------------------------

function extractCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function extractMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}

/** Les codes que l'écran sait expliquer. Le reste passe par le message du serveur. */
const ERROR_ADVICE: Record<string, string> = {
  BRIEF_NOT_APPROVED:
    'La fiche maître n’est pas validée : la valider dans la vue Conversation avant de générer.',
  BRIEF_MISSING: 'Aucune fiche maître pour ce projet : la produire dans la vue Conversation.',
  ANGLE_NOT_SELECTED:
    'Aucun angle sélectionné pour cette génération : choisir un angle dans la liste des sujets.',
  NO_CONTENT_TARGET: 'Aucune plateforme sélectionnée : cocher au moins une cible.',
  REGENERATION_LIMIT:
    'Plafond de régénérations atteint pour ce contenu : modifier le texte à la main, ou revoir l’angle et la fiche maître.',
  CONTENT_ARCHIVED:
    'Ce contenu est archivé (rejeté) : il ne se régénère plus. Une nouvelle génération depuis l’angle reste possible.',
  CONTENT_STATE_TRANSITION:
    'Transition refusée par le domaine : ouvrir la relecture du contenu avant de l’approuver.',
  CONTENT_NO_VERSION: 'Ce contenu n’a aucune version : lancer la génération avant d’approuver.',
  NOTHING_TO_REGENERATE: 'Aucun brouillon à régénérer : ce contenu n’a pas encore de version.',
  REGENERATION_TARGET_MISMATCH:
    'La régénération porte sur une autre plateforme que ce contenu : utiliser la carte du contenu.',
  CONTENT_MISSING_ANGLE: 'Ce contenu n’est rattaché à aucun angle : il ne se régénère pas.',
  CONTENT_NOT_FOUND: 'Contenu introuvable : recharger l’écran.',
  SUBJECT_NOT_FOUND: 'Sujet introuvable : recharger l’écran.',
  ANGLE_NOT_FOUND: 'Angle introuvable : recharger l’écran.',
  PROJECT_NOT_FOUND: 'Projet introuvable : le sélectionner à nouveau.',
  JOB_NOT_FOUND: 'Job introuvable : le suivi est interrompu, la liste des jobs reste disponible.',
  BUDGET_EXCEEDED:
    'Budget du jour atteint : la génération est bloquée jusqu’à demain (ou augmenter la limite).',
  CONTENT_EDIT_INVALID:
    'Le texte envoyé est refusé (forme ou longueur) : lire la raison détaillée au-dessus du bouton.',
};

/**
 * Traduit un refus de l'API en phrase actionnable.
 *
 * Un code brut (`CONTENT_STATE_TRANSITION`) n'apprend rien ; « ouvrir d'abord la
 * relecture » apprend quoi faire. Les codes non répertoriés gardent leur message
 * — l'API écrit déjà en français — complété du code, pour que la trace reste
 * remontable.
 */
export function describeApiError(error: unknown, fallback = 'L’action a échoué.'): string {
  const code = extractCode(error);
  const message = extractMessage(error);
  const advice = code ? ERROR_ADVICE[code] : undefined;
  if (advice) return advice;

  const raw = message ?? '';
  // Aucune réponse HTTP : c'est l'API qui est injoignable, pas la requête qui est
  // refusée. Le dire évite de chercher un bug de données qui n'existe pas.
  if (/failed to fetch|network|load failed|econnrefused|fetch failed/i.test(raw)) {
    return 'API injoignable : vérifier que l’API et le worker tournent (`pnpm dev`).';
  }
  if (code?.startsWith('LLM_')) {
    return `Le modèle n’a pas pu produire ce contenu (${code}). Relancer la génération ; si cela se répète, vérifier la clé et le prompt.`;
  }
  if (message && code) return `${message} (${code})`;
  return message ?? fallback;
}

/**
 * Vrai si l'erreur vient du **domaine** (une règle a dit non), faux si elle vient
 * du transport. L'écran ne raconte pas la même chose dans les deux cas : une règle
 * ne se réessaie pas, un réseau si.
 */
export function isDomainRefusal(error: unknown): boolean {
  const code = extractCode(error);
  if (code !== null) return true;
  const raw = extractMessage(error) ?? '';
  return !/failed to fetch|network|load failed|econnrefused|fetch failed/i.test(raw);
}
