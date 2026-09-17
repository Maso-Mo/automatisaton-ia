import {
  ConflictError,
  hashText,
  NotFoundError,
  ValidationError,
  contentTargetSpec,
  sortContentTargets,
  type ContentDraftsOutput,
  type ContentGeneration,
  type ContentState,
  type ContentTarget,
  type TargetDraft,
} from '@aia/shared';
import type { MasterBrief } from '../conversation/types';
import type { AudienceProfile, StyleProfile } from '../projects/profiles';
import type { ProjectSkillFact } from '../projects/skills';
import type { Project, ProjectFact } from '../projects/types';
import type {
  ContentBundle,
  ContentItem,
  ContentSubject,
  ContentVersion,
  EditorialPorts,
  NewReviewNoteRecord,
  SubjectAngle,
} from './types';
import {
  describeIssues,
  editRatioPercent,
  readingTimeSec,
  validateDraft,
  type DraftValidation,
} from './validation';

/**
 * Le **contenu versionné** : écrire, régénérer, approuver (docs/03 §9.1 à §9.3,
 * docs/05 §4.3, docs/07 §11.2).
 *
 * Trois règles non négociables y sont appliquées :
 *
 * 1. **une version ne se modifie pas** : toute écriture crée une ligne, et
 *    `current_version_id` désigne la dernière. La base le garantit aussi
 *    (`trg_content_versions_immutable`, migration 0003) ;
 * 2. **aucune publication sans approbation** : `approved_version_id` est la
 *    preuve, et la régénération d'un contenu approuvé **efface** l'approbation —
 *    approuver un texte puis en écrire un autre ne peut pas passer inaperçu
 *    (docs/05 §4.3) ;
 * 3. **les transitions d'état sont fermées** : une table explicite, pas une
 *    suite de conditions dispersées. C'est elle qui empêche un contenu
 *    `published` de redevenir `draft` par une route oubliée.
 */

/**
 * Transitions autorisées, état par état (docs/03 §9.1).
 *
 * La table suit le diagramme du modèle de données, avec **trois écarts
 * assumés**, chacun nécessaire à un cas d'usage de cette étape :
 *
 * 1. `generated → editing` : régénérer un contenu jamais relu le fait passer par
 *    la relecture sans repayer un aller-retour `in_review` ;
 * 2. `approved → editing` : c'est le détour obligé d'une régénération d'un
 *    contenu approuvé (« toute modification après approbation repasse par
 *    editing et efface l'approbation », docs/05 §4.3) ;
 * 3. `editing → generated` et `scheduled → in_review` : le retour en arrière
 *    prévu par docs/03 §9.1, pour qu'une nouvelle version ne puisse pas être
 *    publiée sous une approbation qui ne la couvre pas.
 *
 * Ce qui n'y figure **pas** compte autant : `generated → approved` est absent,
 * donc aucun contenu ne peut être approuvé sans être passé par `in_review`. La
 * transition d'état n'est pas une garde suffisante — `approved_version_id` reste
 * la preuve — mais elle empêche qu'une route oubliée produise cette preuve par
 * accident.
 */
export const CONTENT_STATE_TRANSITIONS: Record<ContentState, readonly ContentState[]> = {
  draft: ['generated', 'archived'],
  generated: ['in_review', 'editing', 'archived'],
  in_review: ['editing', 'approved', 'archived'],
  editing: ['in_review', 'generated', 'archived'],
  approved: ['scheduled', 'publishing', 'in_review', 'editing', 'archived'],
  // Les états suivants appartiennent aux étapes 5 et 6 : déclarés ici parce que
  // la table doit être complète, jamais atteints par le code de l'étape 4.
  scheduled: ['publishing', 'in_review', 'approved', 'archived'],
  publishing: ['published', 'publish_failed', 'publish_ambiguous'],
  published: ['archived'],
  publish_failed: ['approved', 'publishing', 'archived'],
  publish_ambiguous: ['published', 'approved', 'archived'],
  archived: [],
};

/**
 * Plafond de régénérations par contenu (docs/05 §4.3) : au-delà, le problème est
 * dans l'angle ou dans la fiche, pas dans le texte — et « régénérer » ne doit
 * jamais devenir un bouton qu'on presse dix fois.
 */
export const MAX_REGENERATIONS_PER_ITEM = 3;

export function assertTransition(from: ContentState, to: ContentState): void {
  if (from === to) return;
  if (!CONTENT_STATE_TRANSITIONS[from].includes(to)) {
    throw new ConflictError(
      `Transition impossible : ${from} → ${to} (états autorisés : ${CONTENT_STATE_TRANSITIONS[from].join(', ') || 'aucun'}).`,
      { code: 'CONTENT_STATE_TRANSITION', details: { from, to } },
    );
  }
}

function itemOrThrow(ports: EditorialPorts, itemId: string): ContentItem {
  const item = ports.store.getContentItem(itemId);
  if (!item) {
    throw new NotFoundError(`Contenu introuvable : ${itemId}`, {
      code: 'CONTENT_NOT_FOUND',
      details: { itemId },
    });
  }
  return item;
}

/** Le contenu, sa version courante et ses remarques : ce que l'API renvoie. */
export function contentBundle(ports: EditorialPorts, itemId: string): ContentBundle {
  const item = itemOrThrow(ports, itemId);
  const version = item.currentVersionId ? ports.store.getVersion(item.currentVersionId) : null;
  return { item, version, notes: ports.store.listNotes(itemId) };
}

export function listProjectContent(
  ports: EditorialPorts,
  projectId: string,
  filter?: { state?: ContentState },
): ContentBundle[] {
  return ports.store.listContentItems(projectId, filter).map((item) => ({
    item,
    version: item.currentVersionId ? ports.store.getVersion(item.currentVersionId) : null,
    notes: ports.store.listNotes(item.id),
  }));
}

/**
 * Marque un contenu comme **en cours de validation** : c'est l'ouverture de
 * l'écran de relecture qui déclenche la transition, pas la génération. Un contenu
 * resté en `generated` n'a jamais été relu — la distinction est visible dans la
 * liste, et c'est exactement ce qu'on veut savoir.
 */
export function markInReview(ports: EditorialPorts, itemId: string): ContentBundle {
  const item = itemOrThrow(ports, itemId);
  assertTransition(item.state, 'in_review');
  ports.store.updateContentItem(itemId, { state: 'in_review' });
  return contentBundle(ports, itemId);
}

/** Plateforme, format et libellé d'une cible : dérivés de la spécification. */
export function targetMeta(target: ContentTarget): {
  platform: ContentItem['platform'];
  format: ContentItem['format'];
  label: string;
} {
  const spec = contentTargetSpec(target);
  return { platform: spec.platform, format: spec.format, label: spec.label };
}

/** Les cibles dont le brouillon a échoué au contrôle : elles seules sont régénérées. */
export function needsRegeneration(validations: readonly DraftValidation[]): ContentTarget[] {
  return validations.filter((validation) => !validation.ok).map((validation) => validation.target);
}

/**
 * Avance un contenu vers un état cible. Quand la transition directe n'existe pas,
 * un détour par `editing` est tenté — c'est le cas d'un contenu **approuvé**
 * qu'une régénération remet en écriture (docs/03 §9.1 : « toute modification
 * après approbation repasse par editing et efface l'approbation »).
 */
function advanceThrough(ports: EditorialPorts, item: ContentItem, target: ContentState): void {
  if (item.state === target) return;
  if (CONTENT_STATE_TRANSITIONS[item.state].includes(target)) {
    ports.store.updateContentItem(item.id, { state: target });
    return;
  }
  if (CONTENT_STATE_TRANSITIONS[item.state].includes('editing')) {
    ports.store.updateContentItem(item.id, { state: 'editing' });
    ports.store.updateContentItem(item.id, { state: target });
    return;
  }
  throw new ConflictError(`Transition impossible : ${item.state} → ${target}.`, {
    code: 'CONTENT_STATE_TRANSITION',
    details: { from: item.state, to: target },
  });
}

/** Garde-fou de régénération : plafond et états terminaux (docs/05 §4.3). */
export function assertRegenerationAllowed(item: ContentItem): void {
  if (item.state === 'archived') {
    throw new ConflictError('Un contenu archivé ne se régénère pas.', {
      code: 'CONTENT_ARCHIVED',
      details: { itemId: item.id },
    });
  }
  if (item.regeneratedCount >= MAX_REGENERATIONS_PER_ITEM) {
    throw new ConflictError(
      `Limite de ${MAX_REGENERATIONS_PER_ITEM} régénérations atteinte : corriger l’angle ou la fiche plutôt que de régénérer encore.`,
      { code: 'REGENERATION_LIMIT', details: { itemId: item.id, count: item.regeneratedCount } },
    );
  }
}

export interface RecordDraftInput {
  item: ContentItem;
  draft: TargetDraft;
  generation: ContentGeneration;
  promptVersionHash: string | null;
  llmCallId: string | null;
  modelUsed: string | null;
  temperatureX100: number | null;
  /**
   * Empreinte du contexte exact envoyé au modèle (`llm_calls.context_fingerprint`,
   * docs/03 §14.4). Elle est recombinée avec la cible pour former le
   * `content_hash` du contenu : deux contenus nés du même angle, du même brief et
   * du même style portent la même empreinte, et c'est ainsi qu'un doublon se
   * voit.
   */
  contextFingerprint: string | null;
  /** Auteur des remarques du modèle, par exemple `platform_writer`. */
  author: string;
  /** Notes ajoutées à celles du brouillon (régénération ciblée). */
  extraNotes?: readonly NewReviewNoteRecord[];
}

export interface RecordedDraft {
  item: ContentItem;
  version: ContentVersion;
  validation: DraftValidation;
}

// --- Contexte de génération -----------------------------------------------

/**
 * Tout ce dont un rédacteur a besoin, assemblé **localement** avant l'appel
 * (docs/05 §4.3, sous-étape `build_context`).
 *
 * Le contexte est un objet explicite, jamais une concaténation de requêtes
 * dispersées : c'est ce qui permet de le tester, de le borner en taille et d'en
 * calculer l'empreinte (`context_fingerprint`) — donc de savoir six mois plus
 * tard ce qui a produit un texte.
 */
export interface ContentContext {
  project: Project;
  brief: MasterBrief | null;
  subject: ContentSubject;
  angle: SubjectAngle;
  /** Les faits du projet : la **seule** matière autorisée (docs/04 §4.3). */
  facts: ProjectFact[];
  skills: ProjectSkillFact[];
  audience: AudienceProfile | null;
  style: StyleProfile | null;
  /** Titres déjà au plan : l'anti-répétition de docs/03 §8.2. */
  recentTitles: string[];
}

/**
 * Résout le sujet et l'angle d'une génération, et vérifie ce qui doit l'être
 * **avant** de payer un appel :
 *
 * 1. l'angle existe et son sujet aussi ;
 * 2. l'angle est bien celui qui a été **choisi** — on ne génère pas un contenu à
 *    partir d'un angle que l'utilisateur n'a pas retenu ;
 * 3. le sujet appartient au projet demandé : un identifiant d'angle ne doit pas
 *    pouvoir faire écrire dans le projet du voisin.
 */
export function contentContext(
  ports: EditorialPorts,
  input: { projectId: string; angleId: string },
): ContentContext {
  const angle = ports.store.getAngle(input.angleId);
  if (!angle) {
    throw new NotFoundError(`Angle introuvable : ${input.angleId}`, {
      code: 'ANGLE_NOT_FOUND',
      details: { angleId: input.angleId },
    });
  }
  if (!angle.selected) {
    throw new ConflictError(
      'Cet angle n’a pas été choisi : sélectionner un angle avant de générer le contenu.',
      { code: 'ANGLE_NOT_SELECTED', details: { angleId: angle.id } },
    );
  }

  const subject = ports.store.getSubject(angle.subjectId);
  if (!subject) {
    throw new NotFoundError(`Sujet introuvable pour l’angle ${angle.id}`, {
      code: 'SUBJECT_NOT_FOUND',
      details: { angleId: angle.id, subjectId: angle.subjectId },
    });
  }
  if (subject.projectId !== input.projectId) {
    throw new ValidationError(
      `Le sujet ${subject.id} appartient à un autre projet que celui demandé.`,
      {
        code: 'SUBJECT_PROJECT_MISMATCH',
        details: { subjectId: subject.id, projectId: input.projectId },
      },
    );
  }

  const project = ports.memory.projects.byId(input.projectId);
  if (!project) {
    throw new NotFoundError(`Projet introuvable : ${input.projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      details: { projectId: input.projectId },
    });
  }

  const audiences = ports.memory.audienceProfiles.list(input.projectId);
  const styles = ports.memory.styleProfiles.list(input.projectId);

  return {
    project,
    brief: ports.briefs.current(input.projectId) ?? null,
    subject,
    angle,
    facts: ports.memory.facts.list({ projectId: input.projectId }),
    skills: ports.memory.skillFacts.list(input.projectId),
    audience: audiences.length > 0 ? (audiences[0] ?? null) : null,
    style: styles.length > 0 ? (styles[0] ?? null) : null,
    recentTitles: ports.store.listSubjectTitles(input.projectId),
  };
}

/**
 * La **fiche maître validée** est le préalable de toute écriture (docs/05 §4.2).
 *
 * Le contrôle est ici, dans le domaine, et pas seulement dans la route : une
 * régénération demandée par le worker ou par un test passe par le même chemin,
 * donc par la même garde. Un contenu écrit sur une fiche jamais validée serait
 * un contenu que l'utilisateur n'a pas demandé.
 */
export function assertBriefApproved(ports: EditorialPorts, projectId: string): MasterBrief {
  const brief = ports.briefs.current(projectId);
  if (!brief) {
    throw new ValidationError(
      'Aucune fiche maître pour ce projet : la conversation doit produire une fiche avant la rédaction.',
      { code: 'BRIEF_MISSING', details: { projectId } },
    );
  }
  if (brief.status !== 'validated') {
    throw new ConflictError(
      `La fiche maître n’est pas validée (statut « ${brief.status} ») : valider la fiche avant de générer du contenu.`,
      { code: 'BRIEF_NOT_APPROVED', details: { briefId: brief.id, status: brief.status } },
    );
  }
  return brief;
}

/**
 * Le `content_hash` d'un contenu : angle + fiche maître + empreinte du contexte
 * + cible (docs/03 §9.1). Recalculé à chaque écriture, il répond à « ce contenu
 * a-t-il déjà été produit dans les mêmes conditions ? ».
 */
export function contentFingerprint(input: {
  projectId: string;
  angleId: string | null;
  briefId: string | null;
  target: ContentTarget;
  contextFingerprint: string | null;
}): string {
  return hashText(
    [
      input.projectId,
      input.angleId ?? '',
      input.briefId ?? '',
      input.contextFingerprint ?? '',
      input.target,
    ].join('|'),
  );
}

// --- Création des contenus ------------------------------------------------

export interface CreateContentItemsInput {
  projectId: string;
  subjectId: string | null;
  angleId: string | null;
  /** Les cibles demandées, dans n'importe quel ordre : elles sont triées ici. */
  targets: readonly ContentTarget[];
}

/**
 * Crée **un contenu par cible demandée**, avant tout appel au modèle.
 *
 * Pourquoi créer les lignes avant d'écrire : si le modèle échoue, il reste cinq
 * contenus vides visibles dans la liste, pas rien. L'utilisateur voit que la
 * génération a été tentée, ce qui est exactement l'information dont il a besoin
 * pour relancer — et le job reprenable de docs/05 §4.3 retrouve ses lignes.
 *
 * Les cibles sont triées par `sortContentTargets` : un lot est toujours traité
 * dans le même ordre, tests compris.
 */
export function createContentItems(
  ports: EditorialPorts,
  input: CreateContentItemsInput,
): ContentItem[] {
  const targets = sortContentTargets(input.targets);
  if (targets.length === 0) {
    throw new ValidationError('Aucune cible demandée : rien à générer.', {
      code: 'NO_CONTENT_TARGET',
      details: { projectId: input.projectId },
    });
  }

  return targets.map((target) => {
    const spec = contentTargetSpec(target);
    return ports.store.createContentItem({
      projectId: input.projectId,
      subjectId: input.subjectId,
      angleId: input.angleId,
      platform: spec.platform,
      target,
      format: spec.format,
      contentHash: null,
    });
  });
}

/** État attendu après une écriture (docs/05 §4.3). */
function stateAfterWrite(item: ContentItem, generation: ContentGeneration): ContentState {
  if (generation === 'initial') return 'generated';
  // Une régénération ou une édition d'un contenu déjà approuvé (ou déjà en
  // relecture) **repasse par la relecture** : l'approbation précédente ne couvre
  // pas le nouveau texte. C'est la règle « approuver un texte puis en écrire un
  // autre ne peut pas passer inaperçu » (docs/05 §4.3).
  const needsReview =
    item.approvedVersionId !== null || item.state === 'in_review' || item.state === 'editing';
  return needsReview ? 'in_review' : 'generated';
}

/**
 * Enregistre un brouillon : **toujours une nouvelle version**, jamais une
 * modification (docs/03 §9.2).
 *
 * Trois choses s'y décident, et elles sont toutes locales :
 *
 * 1. **le contrôle de forme** (`validateDraft`) : les limites de la plateforme
 *    sont vérifiées en code, pas demandées au modèle. Un texte hors limite est
 *    **conservé** — il est instructif — mais marqué comme échoué ;
 * 2. **les remarques** : les notes opérationnelles du modèle, les problèmes
 *    bloquants et les avertissements deviennent des lignes visibles à côté du
 *    texte (docs/03 §9.4) ;
 * 3. **l'effacement de l'approbation** : une écriture non initiale sur un contenu
 *    approuvé remet `approved_version_id` à `null` et l'état à `in_review`.
 */
export function recordDraft(ports: EditorialPorts, input: RecordDraftInput): RecordedDraft {
  const { item, draft } = input;
  const validation = validateDraft(item.target, draft);

  const version = ports.store.addVersion({
    contentItemId: item.id,
    versionNumber: ports.store.nextVersionNumber(item.id),
    body: draft.body,
    title: draft.title ?? null,
    hook: draft.hook?.trim() ?? null,
    hashtags: draft.hashtags ?? [],
    mentions: draft.mentions ?? [],
    charCount: validation.stats.charCount,
    wordCount: validation.stats.wordCount,
    readingTimeSec: readingTimeSec(
      draft.body,
      contentTargetSpec(item.target).format !== 'post_texte',
    ),
    generation: input.generation,
    promptVersionHash: input.promptVersionHash,
    llmCallId: input.llmCallId,
    modelUsed: input.modelUsed,
    temperatureX100: input.temperatureX100,
  });

  const notes: NewReviewNoteRecord[] = [
    ...(draft.notes ?? []).map((message) => ({
      noteType: 'suggestion' as const,
      severity: 'info' as const,
      message,
      anchorText: null,
    })),
    ...validation.blocking.map((issue) => ({
      noteType: 'erreur' as const,
      severity: 'haute' as const,
      message: issue.message,
      anchorText: null,
    })),
    ...validation.warnings.map((issue) => ({
      noteType: 'warning' as const,
      severity: 'basse' as const,
      message: issue.message,
      anchorText: null,
    })),
    ...(input.extraNotes ?? []),
  ];
  if (notes.length > 0) {
    ports.store.replaceNotes(item.id, version.id, input.author, notes);
  }

  advanceThrough(ports, item, stateAfterWrite(item, input.generation));

  const updated = ports.store.updateContentItem(item.id, {
    currentVersionId: version.id,
    ...(draft.title ? { title: draft.title } : {}),
    contentHash: contentFingerprint({
      projectId: item.projectId,
      angleId: item.angleId,
      briefId: ports.briefs.current(item.projectId)?.id ?? null,
      target: item.target,
      contextFingerprint: input.contextFingerprint,
    }),
    ...(item.approvedVersionId !== null ? { approvedVersionId: null, approvedAt: null } : {}),
    ...(input.generation === 'regenerated' ? { regeneratedCount: item.regeneratedCount + 1 } : {}),
    ...(input.generation === 'edited' ? { humanEdited: true } : {}),
  });

  return { item: updated, version, validation };
}

// --- Couverture d'un lot ---------------------------------------------------

/**
 * Le brouillon d'une cible dans la sortie du modèle.
 *
 * Le schéma de sortie est un `record` (docs/shared : une régénération ciblée n'en
 * demande qu'une), donc **Zod ne peut pas garantir** que toutes les cibles
 * demandées sont là. C'est le domaine qui le vérifie, et il le vérifie ici : un
 * lot auquel il manque une plateforme doit échouer bruyamment, jamais produire
 * trois contenus sur quatre en silence.
 */
export function pickDraft(output: ContentDraftsOutput, target: ContentTarget): TargetDraft {
  const draft = output.drafts[target];
  if (!draft) {
    throw new ValidationError(
      `Le modèle n’a pas produit la cible « ${contentTargetSpec(target).label} » : le lot est incomplet.`,
      { code: 'DRAFT_MISSING', details: { target } },
    );
  }
  return draft;
}

/**
 * Les clés produites qui n'étaient pas demandées. Elles ne sont **jamais**
 * utilisées : une cible inventée par le modèle n'est pas un contenu, c'est un
 * signe que le prompt ou la demande a été mal compris — on le journalise.
 */
export function unexpectedTargets(
  output: ContentDraftsOutput,
  requested: readonly ContentTarget[],
): string[] {
  const allowed = new Set<string>(requested);
  return Object.keys(output.drafts).filter((key) => !allowed.has(key));
}

// --- Régénération ciblée --------------------------------------------------

/**
 * Nombre de tentatives de réécriture par cible **et par génération**
 * (docs/05 §4.4 : « Régénération de cette plateforme seule — borne 1 »).
 *
 * La borne n'est pas une politesse : régénérer coûte cher, et une deuxième
 * tentative échoue presque toujours pour la même raison — un angle trop large ou
 * une fiche incomplète. Au-delà, on présente le contenu **avec ses remarques** et
 * on laisse l'utilisateur trancher (docs/05 §4.4).
 */
export const REGENERATION_ATTEMPTS_PER_TARGET = 1;

export interface RegenerationRequest {
  item: ContentItem;
  /** Les cibles à réécrire : **seules** celles dont le contrôle a échoué. */
  targets: ContentTarget[];
  /** Ce qui est reproché, en clair : envoyé au modèle et affiché à l'utilisateur. */
  reasons: string[];
  /** Les notes à rattacher à la nouvelle version. */
  notes: NewReviewNoteRecord[];
}

/**
 * Prépare une régénération **ciblée** : on ne réécrit que ce qui a échoué
 * (docs/04 §4.3). Une cible qui a passé le contrôle n'est jamais régénérée —
 * payer un appel pour obtenir un texte équivalent est le gaspillage le plus
 * facile à éviter.
 *
 * La fonction ne fait **aucun** appel et n'écrit rien : elle vérifie les gardes
 * (contenu non archivé, plafond de régénérations) et rend la commande. L'écriture
 * a lieu dans `recordDraft`, une fois le texte obtenu — une panne du modèle ne
 * doit pas laisser un contenu en `in_review` sans nouvelle version.
 */
export function planRegeneration(
  ports: EditorialPorts,
  itemId: string,
  validations: readonly DraftValidation[],
): RegenerationRequest {
  const item = itemOrThrow(ports, itemId);
  assertRegenerationAllowed(item);

  const targets = needsRegeneration(validations);
  if (targets.length === 0) {
    throw new ValidationError('Aucune cible en échec : rien à régénérer.', {
      code: 'NOTHING_TO_REGENERATE',
      details: { itemId },
    });
  }

  const failures = validations.filter((validation) => targets.includes(validation.target));
  const reasons = failures.map(
    (validation) => `${contentTargetSpec(validation.target).label} — ${describeIssues(validation)}`,
  );

  return {
    item,
    targets,
    reasons,
    notes: reasons.map((message) => ({
      noteType: 'decision' as const,
      severity: 'moyenne' as const,
      message: `Régénération ciblée demandée : ${message}`,
      anchorText: null,
    })),
  };
}

// --- Édition manuelle -----------------------------------------------------

export interface EditContentInput {
  itemId: string;
  draft: TargetDraft;
  /** Auteur de la modification : `user` en V1, jamais un agent. */
  author: string;
}

/**
 * L'**édition manuelle** d'un contenu : une nouvelle version, marquée `edited`.
 *
 * Deux mesures en sortent, et elles servent le produit, pas le contenu :
 * `human_edited` dit qu'une main est passée, `edit_ratio` dit combien
 * (docs/05 §4.5). Proche de 100 %, le modèle n'a servi à rien ; proche de 0 %,
 * l'utilisateur accepte sans lire. La zone utile est au milieu, et elle se suit.
 *
 * Modifier un contenu **approuvé** n'est pas interdit : c'est une nouvelle
 * version, et l'approbation tombe — la publication reste impossible tant que
 * l'utilisateur n'a pas réapprouvé.
 */
export function editContent(ports: EditorialPorts, input: EditContentInput): RecordedDraft {
  const item = itemOrThrow(ports, input.itemId);
  if (item.state === 'archived') {
    throw new ConflictError('Un contenu archivé ne se modifie plus.', {
      code: 'CONTENT_ARCHIVED',
      details: { itemId: item.id },
    });
  }

  const current = item.currentVersionId ? ports.store.getVersion(item.currentVersionId) : null;
  const recorded = recordDraft(ports, {
    item,
    draft: input.draft,
    generation: 'edited',
    promptVersionHash: current?.promptVersionHash ?? null,
    llmCallId: null,
    modelUsed: null,
    temperatureX100: null,
    contextFingerprint: null,
    author: input.author,
  });

  const updated = ports.store.updateContentItem(item.id, {
    editRatio: current ? editRatioPercent(current.body, recorded.version.body) : null,
  });

  return { item: updated, version: recorded.version, validation: recorded.validation };
}

// --- Approbation, archivage, historique -----------------------------------

/**
 * **L'approbation explicite** : l'invariant n° 1 du produit (docs/03 §9.1).
 *
 * Deux vérifications, dans cet ordre :
 *
 * 1. l'état autorise la transition — un contenu jamais relu ne peut pas être
 *    approuvé, la table des transitions s'en charge ;
 * 2. il y a bien une version à approuver : on n'approuve pas du vide.
 *
 * La preuve est enregistrée **des deux côtés** : `approved_version_id` sur le
 * contenu (ce que la publication lira) et `approved_at` / `approved_by` sur la
 * version (qui a approuvé quoi, et quand).
 */
export function approveContent(
  ports: EditorialPorts,
  itemId: string,
  approvedBy: string | null,
): ContentBundle {
  const item = itemOrThrow(ports, itemId);
  assertTransition(item.state, 'approved');

  if (!item.currentVersionId) {
    throw new ConflictError(
      'Ce contenu n’a aucune version : il n’y a rien à approuver (générer avant d’approuver).',
      { code: 'CONTENT_NO_VERSION', details: { itemId } },
    );
  }

  ports.store.approveVersion(item.currentVersionId, approvedBy);
  ports.store.updateContentItem(itemId, {
    state: 'approved',
    approvedVersionId: item.currentVersionId,
    approvedAt: ports.clock.nowMs(),
  });

  return contentBundle(ports, itemId);
}

/** L'archivage : la seule « suppression » du produit (docs/03 §16.1). */
export function archiveContent(ports: EditorialPorts, itemId: string): ContentBundle {
  const item = itemOrThrow(ports, itemId);
  assertTransition(item.state, 'archived');
  ports.store.updateContentItem(itemId, { state: 'archived', archivedAt: ports.clock.nowMs() });
  return contentBundle(ports, itemId);
}

/**
 * Le **rejet** d'un contenu : la décision de l'utilisateur, tracée.
 *
 * Le modèle de données de l'étape 4 n'a pas d'état `rejected`, et ce n'est pas un
 * oubli : un contenu rejeté ne se publiera jamais, exactement comme un contenu
 * archivé. Le rejet est donc un **archivage accompagné d'une décision**
 * (`content_review_notes.note_type = 'decision'`), pas un état de plus. La raison
 * du refus reste lisible dans l'historique, et la table des transitions reste
 * fermée — `archived` est terminal.
 */
export function rejectContent(
  ports: EditorialPorts,
  itemId: string,
  input: { reason: string; author: string },
): ContentBundle {
  const item = itemOrThrow(ports, itemId);
  assertTransition(item.state, 'archived');

  if (item.currentVersionId) {
    ports.store.replaceNotes(item.id, item.currentVersionId, input.author, [
      {
        noteType: 'decision',
        severity: 'moyenne',
        message: input.reason,
        anchorText: null,
      },
    ]);
  }

  ports.store.updateContentItem(itemId, { state: 'archived', archivedAt: ports.clock.nowMs() });
  return contentBundle(ports, itemId);
}

/**
 * L'historique complet d'un contenu : toutes les versions, dans l'ordre, plus
 * les deux identifiants qui comptent — la version courante et celle qui est
 * approuvée.
 *
 * C'est ce que l'écran de comparaison affiche : « ce que j'ai approuvé » et « ce
 * qu'il y a maintenant » doivent pouvoir être regardés **côte à côte**, sinon
 * l'utilisateur n'a aucun moyen de voir qu'un texte a changé sous son
 * approbation.
 */
export function contentHistory(
  ports: EditorialPorts,
  itemId: string,
): {
  item: ContentItem;
  versions: ContentVersion[];
  currentVersionId: string | null;
  approvedVersionId: string | null;
} {
  const item = itemOrThrow(ports, itemId);
  return {
    item,
    versions: ports.store.listVersions(itemId),
    currentVersionId: item.currentVersionId,
    approvedVersionId: item.approvedVersionId,
  };
}
