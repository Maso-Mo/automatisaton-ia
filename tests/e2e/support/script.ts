/**
 * Les textes du parcours, **écrits une seule fois**.
 *
 * `stack.ts` les met dans la bouche du modèle scripté ; la spécification
 * navigateur les cherche à l'écran. Deux copies divergeraient au premier
 * changement d'accroche, et le parcours échouerait pour une raison qui n'a rien
 * à voir avec le produit.
 *
 * Ce fichier n'importe **rien** : il est chargé par Playwright (qui ne connaît
 * pas les alias de `vitest.config.ts`) comme par `tsx`. C'est pour la même
 * raison que les sorties scriptées viennent de `tests/support/*`, jamais d'un
 * module qui chargerait `@aia/*` à la compilation.
 */

/** Le message de l'utilisateur : celui de `tests/support/conversation.ts`. */
export const USER_TURN = 'J’ai automatisé 12 factures avec n8n, je code en TypeScript.';

/** Le projet créé depuis l'écran « Projets » (étape 2). */
export const PROJECT = {
  name: 'Facturation n8n',
  goal: 'Publier un retour d’expérience utile',
  positioning: 'Freelance qui automatise sa facturation',
  description: 'Projet du parcours de bout en bout',
};

/** La réponse scriptée de l'entretien — le texte que l'écran doit afficher. */
export const INTERVIEWER_REPLY = 'Merci, c’est noté. Comment décrirais-tu ton public ?';

/** La synthèse scriptée de la fiche maître — la preuve que la mémoire est remplie. */
export const BRIEF_SUMMARY = 'Un projet d’automatisation de la facturation.';

/** Le premier sujet du plan scripté, et l'accroche du premier angle. */
export const PLAN_FIRST_SUBJECT = 'Automatiser sa facturation sans y passer ses soirées';
export const PLAN_FIRST_HOOK =
  'J’ai automatisé 12 factures en une soirée : voici le montage exact.';

/**
 * Les brouillons scriptés (`tests/support/editorial.ts`, `defaultDrafts`).
 *
 * L'accroche de l'angle et celle du contenu sont **deux textes différents** : le
 * premier est un plan, le second est le texte écrit. Le parcours vérifie les
 * deux, à deux endroits différents.
 */
export const LINKEDIN_DRAFT_HOOK = 'J’ai automatisé 12 factures en une soirée, avec n8n.';
export const REDDIT_DRAFT_HOOK = 'Retour d’expérience : ce qui a marché, et ce qui a cassé.';
export const DRAFT_BODY_FRAGMENT = 'Le montage tient en trois nœuds';

/** La correction manuelle ajoutée au contenu Reddit pendant la relecture. */
export const REDDIT_EDIT =
  'Relu à la main : le chiffre annoncé est vérifiable, la méthode est la mienne.';

/** Le début de la seconde sortie du modèle : la **régénération ciblée**. */
export const REGENERATION_MARKER = 'Version réécrite après relecture.';

/** La consigne saisie avant de régénérer, et le motif du rejet. */
export const REGENERATION_INSTRUCTION = 'Plus court, sans jargon.';
export const REJECTION_REASON = 'Ton trop promotionnel pour ce subreddit.';

/** Les cibles cochées sur l'angle retenu (libellés de `vocabulary.targets`). */
export const LINKEDIN_TARGET = 'Post LinkedIn';
export const REDDIT_TARGET = 'Post Reddit';

/**
 * Parcours 2 — l'**entrée vocale** (étape 6).
 *
 * Le texte de la transcription est écrit **ici**, et `stack.ts` le met dans la
 * bouche du moteur scripté : chercher une autre chaîne à l'écran ne prouverait
 * que la présence d'un texte fixe, pas que le texte affiché est celui que le
 * moteur a produit (docs/09 §1.1).
 */
export const VOICE_PROJECT = {
  name: 'Voix et transcription',
  goal: 'Vérifier l’entrée vocale de bout en bout',
  positioning: 'Projet du parcours vocal',
  description: 'Le parcours qui enregistre, transcrit, corrige et confirme',
};

/** Le tour de texte qui ouvre l'entretien : le micro répond à une question. */
export const VOICE_OPENING_TURN = 'Je veux dicter mes notes plutôt que les taper.';

/**
 * Ce que le moteur scripté a « entendu » : la transcription brute de l'audio.
 *
 * Volontairement **recopiée** de `SCRIPTED_TRANSCRIPT_TEXT` (`@aia/media`), pour
 * la même raison que `USER_TURN` : ce fichier n'importe rien. `stack.ts` la passe
 * explicitement au moteur scripté, si bien qu'une divergence entre les deux
 * chaînes ne rendrait pas le parcours vert à tort — elle le ferait échouer ici,
 * à la première assertion d'écran.
 */
export const VOICE_TRANSCRIPT =
  'J’ai automatisé la facturation avec n8n et je veux raconter le montage exact.';

/** La correction apportée à la main **avant** l'envoi : elle doit partir telle quelle. */
export const VOICE_CORRECTION = 'Relu et corrigé : le montage tient en trois nœuds.';
