import type {
  FactInput,
  ProjectInput,
  ProjectsVocabulary,
  VocabularyOption,
} from '../../api/client';

/**
 * Logique d'interface **pure** de la mémoire des projets (étape 2).
 *
 * Elle vit hors des composants pour une raison précise : une règle de saisie
 * (« l'énoncé ne peut pas être vide », « une URL doit ressembler à une URL »)
 * se teste en quelques millisecondes, sans DOM ni navigateur (docs/09 §1 : le
 * test le moins cher qui détecte la panne). Les composants ne font que rendre le
 * résultat.
 *
 * Les bornes et les valeurs autorisées viennent du **vocabulaire de l'API** :
 * l'interface ne redéfinit jamais une énumération du domaine.
 */

export type FormResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ProjectFormState {
  name: string;
  positioning: string;
  targetGoal: string;
  description: string;
}

export interface FactFormState {
  category: string;
  statement: string;
  detail: string;
  importance: string;
}

export const emptyProjectForm: ProjectFormState = {
  name: '',
  positioning: '',
  targetGoal: '',
  description: '',
};

export function emptyFactForm(defaultCategory = 'note'): FactFormState {
  return { category: defaultCategory, statement: '', detail: '', importance: '3' };
}

/** Liste de sélection prête à afficher : valeur + libellé, jamais une valeur nue. */
export function optionsFor(options: VocabularyOption[]): Array<{ value: string; label: string }> {
  return options.map((option) => ({ value: option.value, label: option.label }));
}

export function labelFor(options: VocabularyOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** États suivants autorisés par le domaine, pour n'afficher que des gestes valides. */
export function allowedNextStatuses(vocabulary: ProjectsVocabulary, status: string): string[] {
  return vocabulary.factVerificationStatuses.find((option) => option.value === status)?.next ?? [];
}

export function projectFormToInput(form: ProjectFormState): FormResult<ProjectInput> {
  const errors: string[] = [];
  const name = form.name.trim();
  if (name.length === 0) errors.push('Le nom du projet est obligatoire.');

  const positioning = form.positioning.trim();
  const targetGoal = form.targetGoal.trim();
  const description = form.description.trim();

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      positioning: positioning.length > 0 ? positioning : null,
      targetGoal: targetGoal.length > 0 ? targetGoal : null,
      ...(description.length > 0 ? { description } : {}),
    },
  };
}

export function factFormToInput(
  form: FactFormState,
  vocabulary: ProjectsVocabulary,
): FormResult<FactInput> {
  const errors: string[] = [];
  const category = form.category;
  if (!vocabulary.factCategories.some((option) => option.value === category)) {
    errors.push('Choisir une catégorie de fait valide.');
  }

  const statement = form.statement.trim();
  if (statement.length === 0) errors.push('L’énoncé du fait est obligatoire.');
  if (statement.length > vocabulary.limits.factStatementMaxLength) {
    errors.push(`L’énoncé dépasse ${vocabulary.limits.factStatementMaxLength} caractères.`);
  }

  const detail = form.detail.trim();
  if (detail.length > vocabulary.limits.factDetailMaxLength) {
    errors.push(`Le détail dépasse ${vocabulary.limits.factDetailMaxLength} caractères.`);
  }

  // `Number` et non `parseInt` : « 2,5 » ou « 2.5 » doit être **refusé**, pas
  // tronqué en 2. Une interface qui corrige silencieusement la saisie fait
  // perdre la trace de ce que l'utilisateur a réellement voulu écrire.
  const importance = Number(form.importance.trim());
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    errors.push('L’importance doit être un entier de 1 à 5.');
  }

  if (category === 'url' && !/^https?:\/\//.test(detail.length > 0 ? detail : statement)) {
    errors.push('Un fait de catégorie « URL » doit commencer par http:// ou https://.');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      category,
      statement,
      detail: detail.length > 0 ? detail : null,
      importance,
    },
  };
}

/** Couleur du badge d'état : un fait confirmé ne ressemble pas à un fait incertain. */
export function factStatusTone(status: string): string {
  switch (status) {
    case 'verified':
      return 'bg-emerald-100 text-emerald-800';
    case 'user_provided':
      return 'bg-sky-100 text-sky-800';
    case 'proposed':
      return 'bg-violet-100 text-violet-800';
    case 'uncertain':
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-slate-200 text-slate-700';
  }
}

export function formatDate(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
