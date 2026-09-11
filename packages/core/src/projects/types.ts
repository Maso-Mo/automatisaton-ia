import type {
  Clock,
  FactCategory,
  FactSource,
  FactVerificationStatus,
  ProjectStatus,
} from '@aia/shared';
import type { ProjectSkillFact, SkillFactPatch } from './skills';
import type { AudienceProfile, StyleProfile } from './profiles';

/**
 * Domaine « projets » — étape 2 : la **mémoire structurée** (docs/10 §4.2, docs/03 §5 et §6).
 *
 * Règle de conception : l'identité d'un projet tient dans `projects` (nom,
 * positionnement, objectif, statut) et **tout le détail vit en faits typés**
 * (`project_facts`) — motivation, problème traité, stack, architecture,
 * fonctionnalités, décisions, difficultés, erreurs, solutions, apprentissages,
 * état actuel, prochaines étapes, URLs, notes. Un seul texte libre serait
 * infiltrable, indatable et non remplaçable (docs/03 §2.5).
 *
 * Ces types sont ceux du domaine : ils sont indépendants de la base. Le paquet
 * `@aia/database` les produit **structurellement** (mêmes noms de champs) sans
 * importer `@aia/core`, ce qui préserve la règle « un paquet d'infrastructure ne
 * dépend jamais du domaine » (docs/02 §5).
 */

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  /** Positionnement en une phrase, écrit par l'utilisateur (docs/03 §5.1). */
  positioning: string | null;
  status: ProjectStatus;
  /** Objectif en clair ; les objectifs mesurables vivent dans `project_goals`. */
  targetGoal: string | null;
  startDate: number | null;
  timezone: string | null;
  language: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface ProjectFact {
  id: string;
  projectId: string;
  category: FactCategory;
  statement: string;
  detail: string | null;
  source: FactSource;
  sourceMessageId: string | null;
  verificationStatus: FactVerificationStatus;
  /** Pourquoi le fait est incertain, obsolète ou remplacé. Jamais une valeur technique. */
  verificationNote: string | null;
  verifiedAt: number | null;
  /** Dénormalisation documentée (docs/03 §6.1) : `true` ⇔ `verified`. */
  verifiedByUser: boolean;
  importance: number;
  usedCount: number;
  lastUsedAt: number | null;
  /** Fait que celui-ci remplace (chaîne d'historique, jamais une suppression). */
  supersedesFactId: string | null;
  /** Fait qui remplace celui-ci : renseigné ⇔ `verificationStatus = 'superseded'`. */
  supersededByFactId: string | null;
  supersededAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** Champs modifiables d'un fait : jamais l'identité, jamais l'historique. */
export interface ProjectFactPatch {
  category?: FactCategory;
  statement?: string;
  detail?: string | null;
  importance?: number;
  updatedAt: number;
  verificationStatus?: FactVerificationStatus;
  verificationNote?: string | null;
  verifiedAt?: number | null;
  verifiedByUser?: boolean;
  supersededByFactId?: string | null;
  supersededAt?: number | null;
}

export interface FactFilter {
  projectId: string;
  categories?: FactCategory[];
  statuses?: FactVerificationStatus[];
  /** Borne basse incluse sur `created_at`. */
  sinceMs?: number;
  /** Borne haute incluse sur `created_at`. */
  untilMs?: number;
  /** `false` (défaut) : les faits remplacés et obsolètes sont exclus. */
  includeInactive?: boolean;
  limit?: number;
}

export interface ProjectFilter {
  statuses?: ProjectStatus[];
  includeArchived?: boolean;
  limit?: number;
}

/**
 * Port de persistance de la mémoire de projet. Le domaine décide, la base
 * stocke : aucune méthode ne contient une règle métier, et aucune ne supprime
 * physiquement (docs/03 §2.6, §16.1).
 */
export interface ProjectMemoryStore {
  projects: {
    insert(record: Project): void;
    patch(id: string, patch: Partial<Project>): number;
    byId(id: string): Project | undefined;
    bySlug(slug: string): Project | undefined;
    list(filter: ProjectFilter): Project[];
  };
  facts: {
    insert(record: ProjectFact): void;
    patch(id: string, patch: ProjectFactPatch): number;
    byId(id: string): ProjectFact | undefined;
    list(filter: FactFilter): ProjectFact[];
  };
  /**
   * Compétences (docs/03 §6.2) : la table qui empêche le produit de faire passer
   * une automatisation pour une compétence de l'utilisateur. Elle arrive dans le
   * port à l'étape 3, parce que l'entretien est la seule façon de la remplir.
   */
  skillFacts: {
    insert(record: ProjectSkillFact): void;
    patch(id: string, patch: SkillFactPatch): number;
    byId(id: string): ProjectSkillFact | undefined;
    list(projectId: string): ProjectSkillFact[];
    byProjectAndSkill(projectId: string, skill: string): ProjectSkillFact | undefined;
  };
  /**
   * Profils d'audience et de style (docs/03 §6.3, §6.4) : remplis par l'entretien
   * (phases `audience` et `voice`), ils racontent pour qui et comment
   * l'utilisateur écrit. Sans eux, aucun contenu n'est « de cet utilisateur ».
   */
  audienceProfiles: {
    insert(record: AudienceProfile): void;
    byId(id: string): AudienceProfile | undefined;
    list(projectId: string): AudienceProfile[];
  };
  styleProfiles: {
    insert(record: StyleProfile): void;
    byId(id: string): StyleProfile | undefined;
    list(projectId: string): StyleProfile[];
  };
  /** Propriétaire courant (mono-utilisateur en V1, docs/03 §4.1). */
  owner: {
    currentId(): string;
  };
  /**
   * Regroupe plusieurs écritures. `better-sqlite3` est synchrone et
   * mono-connexion : toute écriture faite dans le callback est dans la
   * transaction (remplacement d'un fait = deux lignes, jamais une seule).
   */
  transaction<T>(operation: () => T): T;
}

export interface ProjectMemoryPorts {
  store: ProjectMemoryStore;
  /** Horloge injectée : aucun test ne dépend de la date (docs/09 §1.1). */
  clock: Clock;
  /** Générateur d'identifiants (UUID v7) — injecté pour les tests. */
  newId(): string;
}
