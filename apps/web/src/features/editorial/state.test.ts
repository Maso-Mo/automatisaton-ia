import { describe, expect, it } from 'vitest';
import type {
  ContentBundleView,
  ContentNoteView,
  ContentVersionView,
  EditorialVocabulary,
  PublicJob,
} from '../../api/client';
import {
  applyJobProgress,
  buildCard,
  buildCards,
  compareWithApproved,
  describeApiError,
  groupBySection,
  initialJobProgress,
  isDomainRefusal,
  jobStepLabel,
  labelOf,
  noteView,
  rejectionReason,
  reviewSummary,
  versionLabel,
  versionOptions,
} from './state';

/**
 * L'écran de revue ne doit jamais proposer une action que le domaine refuserait,
 * ni cacher une raison de refus. Ces règles sont vérifiées ici, sans navigateur :
 * c'est ce qui permet de couvrir les situations de l'étape 5 — brouillon, lot
 * partiel, texte trop long, édition à la main, régénération plafonnée, rejet,
 * échec de job — sans lancer l'application.
 */

const VOCABULARY: EditorialVocabulary = {
  targets: [
    {
      key: 'linkedin_post',
      label: 'Post LinkedIn',
      sectionLabel: 'LinkedIn',
      platform: 'linkedin',
      format: 'post',
      bodyMaxChars: 3000,
      bodyTargetChars: 1800,
      titleMaxChars: 0,
      hookMaxChars: 300,
      hashtagsMin: 3,
      hashtagsMax: 5,
      segmentsRequired: false,
      shape: 'paragraphes',
      promptFile: 'linkedin-post.md',
    },
    {
      key: 'youtube_short',
      label: 'YouTube — Short',
      sectionLabel: 'YouTube Short',
      platform: 'youtube',
      format: 'short',
      bodyMaxChars: 900,
      bodyTargetChars: 700,
      titleMaxChars: 100,
      hookMaxChars: 120,
      hashtagsMin: 0,
      hashtagsMax: 3,
      segmentsRequired: false,
      shape: 'segments',
      promptFile: 'youtube-short.md',
    },
  ],
  contentStates: [
    { value: 'draft', label: 'Brouillon', next: ['generated', 'archived'] },
    { value: 'generated', label: 'Généré', next: ['in_review', 'archived'] },
    { value: 'in_review', label: 'En relecture', next: ['approved', 'editing', 'archived'] },
    { value: 'editing', label: 'En modification', next: ['in_review', 'approved', 'archived'] },
    { value: 'approved', label: 'Approuvé', next: ['in_review', 'archived'] },
    { value: 'archived', label: 'Archivé', next: [] },
  ],
  generations: [
    { value: 'initial', label: 'Génération initiale' },
    { value: 'regenerated', label: 'Régénération IA' },
    { value: 'edited', label: 'Modification manuelle' },
    { value: 'reformatted', label: 'Reformatage' },
  ],
  noteTypes: [
    { value: 'erreur', label: 'Erreur' },
    { value: 'warning', label: 'Avertissement' },
    { value: 'decision', label: 'Décision' },
  ],
  noteSeverities: [
    { value: 'info', label: 'Information' },
    { value: 'haute', label: 'Haute' },
  ],
  limits: { maxRegenerationsPerItem: 3 },
  subjectStatuses: [
    { value: 'proposed', label: 'Proposé' },
    { value: 'selected', label: 'Choisi' },
    { value: 'produced', label: 'Produit' },
  ],
  skillCoverages: [{ value: 'couverte', label: 'Compétence couverte' }],
  angleTypes: [
    { value: 'retour_experience', label: 'Retour d’expérience' },
    { value: 'tutoriel', label: 'Tutoriel' },
  ],
};

function version(overrides: Partial<ContentVersionView> = {}): ContentVersionView {
  const body = overrides.body ?? 'Un texte de brouillon.';
  return {
    id: 'v1',
    contentItemId: 'c1',
    versionNumber: 1,
    body,
    title: null,
    hook: 'Accroche',
    hashtags: ['#a', '#b', '#c'],
    mentions: [],
    linkUrl: null,
    charCount: body.length,
    wordCount: 4,
    readingTimeSec: 12,
    generation: 'initial',
    modelUsed: 'mistral-large',
    qualityScore: 80,
    approvedAt: null,
    approvedBy: null,
    createdAt: 1_000,
    ...overrides,
  };
}

function note(overrides: Partial<ContentNoteView> = {}): ContentNoteView {
  return {
    id: 'n1',
    contentItemId: 'c1',
    contentVersionId: 'v1',
    author: 'agent',
    noteType: 'warning',
    severity: 'moyenne',
    message: 'Accroche proche du gabarit.',
    anchorText: null,
    resolved: false,
    createdAt: 1_000,
    ...overrides,
  };
}

function bundle(
  overrides: {
    state?: string;
    target?: string;
    versionOverride?: Partial<ContentVersionView> | null;
    notes?: ContentNoteView[];
    item?: Partial<ContentBundleView['item']>;
  } = {},
): ContentBundleView {
  const built = overrides.versionOverride === null ? null : version(overrides.versionOverride);
  return {
    item: {
      id: 'c1',
      projectId: 'p1',
      subjectId: 's1',
      angleId: 'a1',
      platform: 'linkedin',
      target: overrides.target ?? 'linkedin_post',
      format: 'post',
      title: null,
      state: overrides.state ?? 'generated',
      currentVersionId: built?.id ?? null,
      approvedVersionId: null,
      contentHash: 'hash',
      aiGenerated: true,
      humanEdited: false,
      editRatio: null,
      regeneratedCount: 0,
      createdAt: 1_000,
      updatedAt: 1_000,
      approvedAt: null,
      scheduledFor: null,
      publishedAt: null,
      archivedAt: null,
      ...overrides.item,
    },
    version: built,
    notes: overrides.notes ?? [],
    claims: [],
  };
}

describe('cartes de revue : une carte par plateforme (docs/03 §9.1, docs/09 §6)', () => {
  it('refuse l’approbation tant que la relecture n’a pas été ouverte', () => {
    const card = buildCard(bundle({ state: 'generated' }), VOCABULARY);
    expect(card.stateLabel).toBe('Généré');
    expect(card.canApprove).toBe(false);
    // Le refus doit être **expliqué**, pas seulement grisé.
    expect(card.approvalBlockedReason).toContain('relecture');
    expect(card.canRegenerate).toBe(true);
  });

  it('autorise l’approbation après ouverture de la relecture', () => {
    const card = buildCard(
      bundle({
        state: 'in_review',
        notes: [
          note({ id: 'critic', author: 'critic' }),
          note({ id: 'facts', author: 'fact_checker' }),
        ],
      }),
      VOCABULARY,
    );
    expect(card.canApprove).toBe(true);
    expect(card.approvalBlockedReason).toBeNull();
    expect(card.inReview).toBe(true);
  });

  it('n’approuve jamais un contenu archivé, même relu', () => {
    const card = buildCard(bundle({ state: 'archived' }), VOCABULARY);
    expect(card.canApprove).toBe(false);
    expect(card.canRegenerate).toBe(false);
    expect(card.canEdit).toBe(false);
    // `archived` est terminal : aucun état suivant.
    expect(VOCABULARY.contentStates.at(-1)?.next).toEqual([]);
  });

  it('distingue un rejet motivé d’un simple archivage', () => {
    const rejected = buildCard(
      bundle({
        state: 'archived',
        notes: [note({ noteType: 'decision', message: 'Hors sujet.' })],
      }),
      VOCABULARY,
    );
    expect(rejected.rejected).toBe(true);
    expect(rejected.rejectionReason).toBe('Hors sujet.');
    expect(rejected.approvalBlockedReason).toContain('rejeté');

    const archived = buildCard(bundle({ state: 'archived' }), VOCABULARY);
    expect(archived.rejected).toBe(false);
    expect(archived.rejectionReason).toBeNull();
  });

  it('relit une décision vide comme une absence de motif', () => {
    const blank = noteView(note({ noteType: 'decision', message: '   ' }), VOCABULARY);
    expect(rejectionReason([blank])).toBeNull();
  });

  it('mesure le texte face au budget de sa cible, pas d’une autre', () => {
    const long = 'x'.repeat(1200);
    const linkedin = buildCard(bundle({ versionOverride: { body: long } }), VOCABULARY);
    expect(linkedin.charBudget).toBe(3000);
    expect(linkedin.overflowChars).toBe(0);

    const short = buildCard(
      bundle({ target: 'youtube_short', versionOverride: { body: long } }),
      VOCABULARY,
    );
    expect(short.charBudget).toBe(900);
    expect(short.overflowChars).toBe(300);
    expect(short.sectionLabel).toBe('YouTube Short');
    expect(short.targetLabel).toBe('YouTube — Short');
  });

  it('nomme la version courante avec son origine', () => {
    expect(versionLabel(3, 'regenerated', VOCABULARY)).toBe('v3 · Régénération IA');
    expect(versionLabel(1, 'edited', VOCABULARY)).toBe('v1 · Modification manuelle');
    expect(versionLabel(null, null, VOCABULARY)).toBe('aucune version');
  });

  it('ne propose pas de régénération au-delà du plafond servi par l’API', () => {
    const card = buildCard(
      bundle({ state: 'in_review', item: { regeneratedCount: 3 } }),
      VOCABULARY,
    );
    expect(card.regenerationsLeft).toBe(0);
    expect(card.canRegenerate).toBe(false);
    expect(card.regenerateBlockedReason).toContain('3 régénérations');
  });

  it('signale une édition humaine : le texte n’est plus seulement celui du modèle', () => {
    const card = buildCard(
      bundle({
        state: 'editing',
        versionOverride: { generation: 'edited', versionNumber: 2 },
        item: { humanEdited: true, editRatio: 0.4 },
      }),
      VOCABULARY,
    );
    expect(card.versionLabel).toBe('v2 · Modification manuelle');
    expect(card.editRatio).toBe(0.4);
    expect(card.canEdit).toBe(true);
  });

  it('n’approuve pas un contenu sans version : il n’y a rien à approuver', () => {
    const card = buildCard(bundle({ state: 'in_review', versionOverride: null }), VOCABULARY);
    expect(card.versionNumber).toBeNull();
    expect(card.canApprove).toBe(false);
    expect(card.approvalBlockedReason).toContain('générer');
  });

  it('ne déclare approuvé que si la version approuvée est la courante', () => {
    const approvedCard = buildCard(
      bundle({ state: 'approved', item: { approvedVersionId: 'v1' } }),
      VOCABULARY,
    );
    expect(approvedCard.approved).toBe(true);

    // Une régénération après approbation : l'accord portait sur l'ancienne version.
    const stale = buildCard(
      bundle({ state: 'approved', item: { approvedVersionId: 'v0' } }),
      VOCABULARY,
    );
    expect(stale.approved).toBe(false);
  });
});

describe('lots et sections (docs/05 §4.3)', () => {
  it('garde l’ordre du catalogue et une section vide pour une cible absente', () => {
    const cards = buildCards(
      [bundle({ target: 'youtube_short', item: { id: 'c2' } }), bundle({ item: { id: 'c1' } })],
      VOCABULARY,
    );
    expect(cards.map((card) => card.target)).toEqual(['linkedin_post', 'youtube_short']);

    const sections = groupBySection(cards, VOCABULARY);
    expect(sections.map((section) => section.label)).toEqual(['LinkedIn', 'YouTube Short']);
    expect(sections[1]?.cards).toHaveLength(1);
  });

  it('résume un lot partiellement approuvé', () => {
    const cards = buildCards(
      [
        bundle({ item: { id: 'c1', state: 'approved', approvedVersionId: 'v1' } }),
        bundle({
          item: { id: 'c2', state: 'archived' },
          notes: [note({ noteType: 'decision', message: 'Doublon.' })],
        }),
        bundle({ item: { id: 'c3' }, notes: [note()] }),
      ],
      VOCABULARY,
    );
    expect(reviewSummary(cards)).toEqual({
      total: 3,
      approved: 1,
      rejected: 1,
      pending: 1,
      withWarnings: 1,
    });
  });

  it('remonte les erreurs bloquantes du contrôle local sur la carte', () => {
    const cards = buildCards([bundle()], VOCABULARY, {
      c1: ['Body trop long pour LinkedIn (3200 > 3000)'],
    });
    expect(cards[0]?.blockingIssues).toEqual(['Body trop long pour LinkedIn (3200 > 3000)']);
  });
});

describe('historique des versions (docs/03 §9.2)', () => {
  it('liste les versions de la plus récente à la plus ancienne, avec les repères', () => {
    const options = versionOptions(
      [
        version({ id: 'v1', versionNumber: 1 }),
        version({ id: 'v3', versionNumber: 3, generation: 'edited' }),
        version({ id: 'v2', versionNumber: 2, generation: 'regenerated' }),
      ],
      'v3',
      'v1',
      VOCABULARY,
    );
    expect(options.map((option) => option.label)).toEqual([
      'v3 · Modification manuelle',
      'v2 · Régénération IA',
      'v1 · Génération initiale',
    ]);
    expect(options[0]?.isCurrent).toBe(true);
    expect(options[2]?.isApproved).toBe(true);
  });

  it('met côte à côte la version approuvée et la version courante', () => {
    const versions = [
      version({ id: 'v1', versionNumber: 1 }),
      version({ id: 'v2', versionNumber: 2, generation: 'regenerated' }),
    ];
    const compared = compareWithApproved(versions, 'v2', 'v1');
    expect(compared.approved?.versionNumber).toBe(1);
    expect(compared.current?.versionNumber).toBe(2);
  });
});

describe('suivi d’un job de génération (docs/02 §13)', () => {
  const job: PublicJob = {
    id: 'job-1',
    type: 'generate_content',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    progress: 10,
    currentStep: 'build_context',
    createdAt: 1_000,
    startedAt: 1_100,
    finishedAt: null,
    durationMs: null,
    costMicroUsd: 0,
    error: null,
  };

  it('part de l’état complet du job', () => {
    const started = initialJobProgress(job);
    expect(started.statusLabel).toBe('En cours');
    expect(started.progress).toBe(10);
    expect(started.closed).toBe(false);
    expect(jobStepLabel(started.step)).toBe('Assemblage du contexte');
  });

  it('ne recule jamais et conserve le dernier message connu', () => {
    let state = initialJobProgress(job);
    state = applyJobProgress(state, {
      kind: 'event',
      event: { step: 'write_initial', message: 'Rédaction en cours', progress: 40 },
    });
    state = applyJobProgress(state, { kind: 'event', event: { message: 'Contrôle de forme' } });
    expect(state.step).toBe('write_initial');
    expect(state.progress).toBe(40);
    expect(state.message).toBe('Contrôle de forme');

    // Un événement sans progression ne remet pas la barre à zéro.
    state = applyJobProgress(state, { kind: 'event', event: { message: 'encore' } });
    expect(state.progress).toBe(40);
  });

  it('se ferme sur `done` et affiche l’échec plutôt qu’un succès', () => {
    let state = initialJobProgress(job);
    state = applyJobProgress(state, {
      kind: 'done',
      job: { ...job, status: 'failed', progress: 40, error: { message: 'LLM_TIMEOUT' } },
    });
    expect(state.closed).toBe(true);
    expect(state.statusLabel).toBe('Échec');
    expect(state.error).toBe('LLM_TIMEOUT');
  });

  it('ne rend jamais `[object Object]` pour une erreur structurée', () => {
    const state = initialJobProgress({ ...job, status: 'failed', error: { category: 'llm' } });
    expect(state.error).not.toContain('[object Object]');
    expect(state.error).toContain('Le job a échoué');
  });

  it('affiche une raison de fermeture plutôt qu’un flux muet', () => {
    const state = applyJobProgress(initialJobProgress(job), {
      kind: 'closed',
      reason: 'erreur interne',
    });
    expect(state.closed).toBe(true);
    expect(state.message).toBe('erreur interne');
    describe('refus de l’API : une phrase, pas un code (docs/05 §4.1)', () => {
      it('explique les codes que le domaine peut opposer à l’écran', () => {
        expect(
          describeApiError({ code: 'REGENERATION_LIMIT', message: 'Limite atteinte' }),
        ).toContain('Plafond de régénérations');
        expect(describeApiError({ code: 'CONTENT_STATE_TRANSITION' })).toContain('relecture');
        expect(describeApiError({ code: 'BRIEF_NOT_APPROVED' })).toContain('fiche maître');
        expect(describeApiError({ code: 'ANGLE_NOT_SELECTED' })).toContain('angle');
        expect(describeApiError({ code: 'CONTENT_ARCHIVED' })).toContain('archivé');
      });

      it('nomme l’API injoignable sans accuser les données', () => {
        expect(describeApiError(new TypeError('Failed to fetch'))).toContain('API injoignable');
        expect(isDomainRefusal(new TypeError('Failed to fetch'))).toBe(false);
        expect(isDomainRefusal({ code: 'CONTENT_NOT_FOUND' })).toBe(true);
      });

      it('garde le message du serveur quand aucun code connu ne s’applique', () => {
        expect(describeApiError({ code: 'NOUVEAU_CODE', message: 'Refus métier' })).toBe(
          'Refus métier (NOUVEAU_CODE)',
        );
        expect(describeApiError(null)).toBe('L’action a échoué.');
      });

      it('traduit les échecs du modèle en action à tenter', () => {
        expect(describeApiError({ code: 'LLM_TIMEOUT' })).toContain('Relancer la génération');
      });
    });
  });
});

describe('libellés servis par l’API (docs/10 §4.4)', () => {
  it('préfère le libellé du vocabulaire au code du domaine', () => {
    expect(labelOf(VOCABULARY.contentStates, 'in_review')).toBe('En relecture');
    expect(labelOf(VOCABULARY.angleTypes, 'tutoriel')).toBe('Tutoriel');
  });

  it('retombe sur le code, jamais sur du vide', () => {
    // Un état ajouté au domaine doit rester lisible tel qu'il est servi.
    expect(labelOf(VOCABULARY.contentStates, 'publication_ambigue')).toBe('publication_ambigue');
    expect(labelOf(VOCABULARY.contentStates, null)).toBe('—');
  });
});
