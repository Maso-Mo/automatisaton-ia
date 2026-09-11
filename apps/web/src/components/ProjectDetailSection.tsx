import { useState, type FormEvent } from 'react';
import type {
  FactInput,
  ProjectDetail,
  ProjectFactView,
  ProjectInput,
  ProjectsVocabulary,
} from '../api/client';
import {
  emptyFactForm,
  factFormToInput,
  factStatusTone,
  formatDate,
  labelFor,
  optionsFor,
  projectFormToInput,
  type FactFormState,
} from '../features/projects/forms';

export interface FactFilters {
  category: string;
  status: string;
  includeInactive: boolean;
}

/**
 * Page détail d'un projet : identité, édition, faits et contexte (docs/10 §4.2).
 *
 * Les faits sont **classés par état** : un fait confirmé, un fait fourni et un
 * fait incertain ne se ressemblent pas visuellement, parce qu'ils ne valent pas
 * la même chose dans un contenu. Aucun geste impossible n'est proposé : les
 * états suivants viennent du vocabulaire du domaine.
 */
export function ProjectDetailSection({
  detail,
  facts,
  vocabulary,
  isLoading,
  isError,
  errorMessage,
  isLoadingFacts,
  filters,
  pendingAction,
  actionError,
  onFilterChange,
  onEditProject,
  onArchiveProject,
  onAddFact,
  onSetFactVerification,
  onReplaceFact,
}: {
  detail: ProjectDetail | undefined;
  facts: ProjectFactView[];
  vocabulary: ProjectsVocabulary | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  isLoadingFacts: boolean;
  filters: FactFilters;
  pendingAction: string | null;
  actionError: string | null;
  onFilterChange: (filters: FactFilters) => void;
  onEditProject: (input: ProjectInput) => void;
  onArchiveProject: () => void;
  onAddFact: (input: FactInput) => void;
  onSetFactVerification: (factId: string, status: string, note: string | null) => void;
  onReplaceFact: (factId: string, input: FactInput & { note: string | null }) => void;
}) {
  const [projectForm, setProjectForm] = useState({ name: '', positioning: '', targetGoal: '' });
  const [factForm, setFactForm] = useState<FactFormState>(emptyFactForm());
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [replacing, setReplacing] = useState<ProjectFactView | null>(null);
  const [replacementForm, setReplacementForm] = useState<FactFormState>(emptyFactForm());

  if (isLoading) return <p className="text-sm text-slate-600">Chargement du projet…</p>;
  if (isError || !detail) {
    return (
      <p className="text-sm text-rose-700">
        Projet indisponible{errorMessage ? ` : ${errorMessage}` : '.'}
      </p>
    );
  }

  const project = detail.project;
  const archived = project.status === 'archived';
  const categoryOptions = optionsFor(vocabulary?.factCategories ?? []);

  const submitProject = (event: FormEvent): void => {
    event.preventDefault();
    const result = projectFormToInput({
      name: projectForm.name.length > 0 ? projectForm.name : project.name,
      positioning:
        projectForm.name.length > 0 ? projectForm.positioning : (project.positioning ?? ''),
      targetGoal: projectForm.name.length > 0 ? projectForm.targetGoal : (project.targetGoal ?? ''),
      description: '',
    });
    if (!result.ok) {
      setFormErrors(result.errors);
      return;
    }
    setFormErrors([]);
    onEditProject(result.value);
  };

  const submitFact = (event: FormEvent): void => {
    event.preventDefault();
    if (!vocabulary) return;
    const result = factFormToInput(factForm, vocabulary);
    if (!result.ok) {
      setFormErrors(result.errors);
      return;
    }
    setFormErrors([]);
    onAddFact(result.value);
    setFactForm(emptyFactForm(factForm.category));
  };

  const submitReplacement = (event: FormEvent): void => {
    event.preventDefault();
    if (!vocabulary || !replacing) return;
    const result = factFormToInput(replacementForm, vocabulary);
    if (!result.ok) {
      setFormErrors(result.errors);
      return;
    }
    setFormErrors([]);
    onReplaceFact(replacing.id, { ...result.value, note: 'Remplacé depuis l’interface' });
    setReplacing(null);
  };

  const nextStatuses = (status: string): string[] =>
    vocabulary?.factVerificationStatuses.find((option) => option.value === status)?.next ?? [];

  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">{project.name}</h2>
          <p className="text-xs text-slate-500">
            {labelFor(vocabulary?.projectStatuses ?? [], project.status)} ·{' '}
            <span className="font-mono">{project.slug}</span>
            {project.targetGoal ? ` · ${project.targetGoal}` : ''}
            {project.archivedAt ? ` · archivé le ${formatDate(project.archivedAt)}` : ''}
          </p>
          {project.positioning && (
            <p className="mt-1 text-sm text-slate-700">{project.positioning}</p>
          )}
        </div>
        {!archived && (
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-1 text-xs"
              onClick={() =>
                setProjectForm({
                  name: project.name,
                  positioning: project.positioning ?? '',
                  targetGoal: project.targetGoal ?? '',
                })
              }
            >
              Modifier
            </button>
            <button
              type="button"
              className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700"
              onClick={onArchiveProject}
              disabled={pendingAction === 'archive'}
            >
              Archiver
            </button>
          </div>
        )}
      </header>

      {archived && (
        <p className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
          Projet archivé : la mémoire reste consultable, mais plus modifiable.
        </p>
      )}

      {!archived && projectForm.name.length > 0 && (
        <form
          className="mt-4 grid gap-2 border-t border-slate-100 pt-4 sm:grid-cols-3"
          onSubmit={submitProject}
        >
          <label className="text-xs text-slate-600">
            Nom
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              value={projectForm.name}
              onChange={(event) => setProjectForm((c) => ({ ...c, name: event.target.value }))}
              aria-label="Nom du projet à modifier"
            />
          </label>
          <label className="text-xs text-slate-600">
            Positionnement
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              value={projectForm.positioning}
              onChange={(event) =>
                setProjectForm((c) => ({ ...c, positioning: event.target.value }))
              }
              aria-label="Positionnement à modifier"
            />
          </label>
          <label className="text-xs text-slate-600">
            Objectif
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              value={projectForm.targetGoal}
              onChange={(event) =>
                setProjectForm((c) => ({ ...c, targetGoal: event.target.value }))
              }
              aria-label="Objectif à modifier"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white sm:col-span-3 sm:justify-self-start"
            disabled={pendingAction === 'edit-project'}
          >
            Enregistrer
          </button>
        </form>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <article className="rounded border border-slate-200 p-3">
          <h3 className="text-xs uppercase tracking-wide text-slate-500">Mémoire</h3>
          <p className="mt-1 text-sm">
            {detail.summary.total} fait(s) · {detail.summary.trusted} confirmé(s)
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {Object.entries(detail.summary.byStatus)
              .map(
                ([status, count]) =>
                  `${count} ${labelFor(vocabulary?.factVerificationStatuses ?? [], status)}`,
              )
              .join(' · ') || 'aucun fait enregistré'}
          </p>
        </article>
        <article className="rounded border border-slate-200 p-3">
          <h3 className="text-xs uppercase tracking-wide text-slate-500">Contexte retenu</h3>
          <p className="mt-1 text-sm">
            {detail.context.facts.length} fait(s) injectable(s) sur {detail.summary.total}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            écartés : {detail.context.excluded.unverified} non confirmé(s),{' '}
            {detail.context.excluded.inactive} obsolète(s)/remplacé(s),{' '}
            {detail.context.excluded.filtered} hors filtre
          </p>
        </article>
        <article className="rounded border border-slate-200 p-3">
          <h3 className="text-xs uppercase tracking-wide text-slate-500">
            Informations manquantes
          </h3>
          <p className="mt-1 text-xs text-slate-600">
            {detail.context.missingCategories.length === 0
              ? 'rien à compléter'
              : detail.context.missingCategories
                  .map((category) => labelFor(vocabulary?.factCategories ?? [], category))
                  .join(', ')}
          </p>
        </article>
      </div>

      <div className="mt-6 border-t border-slate-100 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Faits du projet</h3>
          <div className="flex flex-wrap items-end gap-2 text-xs text-slate-600">
            <label>
              Catégorie
              <select
                className="mt-1 block rounded border border-slate-300 px-2 py-1"
                value={filters.category}
                onChange={(event) => onFilterChange({ ...filters, category: event.target.value })}
              >
                <option value="">toutes</option>
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              État
              <select
                className="mt-1 block rounded border border-slate-300 px-2 py-1"
                value={filters.status}
                onChange={(event) => onFilterChange({ ...filters, status: event.target.value })}
              >
                <option value="">vivants</option>
                {optionsFor(vocabulary?.factVerificationStatuses ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={filters.includeInactive}
                onChange={(event) =>
                  onFilterChange({ ...filters, includeInactive: event.target.checked })
                }
              />
              historique complet
            </label>
          </div>
        </div>

        {isLoadingFacts && <p className="mt-2 text-sm text-slate-600">Chargement des faits…</p>}
        {!isLoadingFacts && facts.length === 0 && (
          <p className="mt-2 text-sm text-slate-600">Aucun fait pour ce filtre.</p>
        )}

        {facts.length > 0 && (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="pb-1">Catégorie</th>
                <th className="pb-1">Énoncé</th>
                <th className="pb-1">État</th>
                <th className="pb-1">Imp.</th>
                <th className="pb-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((fact) => (
                <tr key={fact.id} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-2 text-xs text-slate-600">
                    {labelFor(vocabulary?.factCategories ?? [], fact.category)}
                    <br />
                    <span className="text-slate-400">
                      {labelFor(vocabulary?.factSources ?? [], fact.source)}
                    </span>
                  </td>
                  <td className="py-1 pr-2">
                    <span className="font-medium">{fact.statement}</span>
                    {fact.detail && <p className="text-xs text-slate-600">{fact.detail}</p>}
                    {fact.verificationNote && (
                      <p className="text-xs text-slate-500">note : {fact.verificationNote}</p>
                    )}
                    {fact.supersededByFactId && (
                      <p className="text-xs text-slate-500">
                        remplacé (fait {fact.supersededByFactId.slice(0, 8)})
                      </p>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${factStatusTone(fact.verificationStatus)}`}
                    >
                      {labelFor(
                        vocabulary?.factVerificationStatuses ?? [],
                        fact.verificationStatus,
                      )}
                    </span>
                    <p className="mt-1 text-xs text-slate-500">
                      maj {formatDate(fact.updatedAt)}
                      {fact.verifiedAt ? ` · confirmé ${formatDate(fact.verifiedAt)}` : ''}
                    </p>
                  </td>
                  <td className="py-1 pr-2 text-xs">{fact.importance}/5</td>
                  <td className="py-1">
                    {!archived && (
                      <div className="flex flex-wrap gap-1">
                        {nextStatuses(fact.verificationStatus)
                          .filter((status) => status !== 'superseded')
                          .map((status) => (
                            <button
                              key={status}
                              type="button"
                              className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                              disabled={pendingAction === fact.id}
                              onClick={() => onSetFactVerification(fact.id, status, null)}
                            >
                              {labelFor(vocabulary?.factVerificationStatuses ?? [], status)}
                            </button>
                          ))}
                        <button
                          type="button"
                          className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                          disabled={pendingAction === fact.id}
                          onClick={() => {
                            setReplacing(fact);
                            setReplacementForm({
                              category: fact.category,
                              statement: fact.statement,
                              detail: fact.detail ?? '',
                              importance: String(fact.importance),
                            });
                          }}
                        >
                          Remplacer
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!archived && (
          <form
            className="mt-4 grid gap-2 border-t border-slate-100 pt-4"
            onSubmit={replacing ? submitReplacement : submitFact}
          >
            <h4 className="text-sm font-medium">
              {replacing ? 'Remplacer un fait' : 'Ajouter un fait'}
            </h4>
            {replacing && (
              <p className="text-xs text-slate-600">
                Le fait « {replacing.statement} » sera conservé comme remplacé : rien n’est
                supprimé.
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-4">
              <label className="text-xs text-slate-600">
                Catégorie
                <select
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  value={replacing ? replacementForm.category : factForm.category}
                  onChange={(event) =>
                    replacing
                      ? setReplacementForm((c) => ({ ...c, category: event.target.value }))
                      : setFactForm((c) => ({ ...c, category: event.target.value }))
                  }
                  aria-label="Catégorie du fait"
                >
                  {categoryOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600 sm:col-span-2">
                Énoncé
                <input
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  value={replacing ? replacementForm.statement : factForm.statement}
                  onChange={(event) =>
                    replacing
                      ? setReplacementForm((c) => ({ ...c, statement: event.target.value }))
                      : setFactForm((c) => ({ ...c, statement: event.target.value }))
                  }
                  aria-label="Énoncé du fait"
                />
              </label>
              <label className="text-xs text-slate-600">
                Importance (1–5)
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  value={replacing ? replacementForm.importance : factForm.importance}
                  onChange={(event) =>
                    replacing
                      ? setReplacementForm((c) => ({ ...c, importance: event.target.value }))
                      : setFactForm((c) => ({ ...c, importance: event.target.value }))
                  }
                  aria-label="Importance du fait"
                />
              </label>
              <label className="text-xs text-slate-600 sm:col-span-4">
                Détail (facultatif)
                <textarea
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  rows={2}
                  value={replacing ? replacementForm.detail : factForm.detail}
                  onChange={(event) =>
                    replacing
                      ? setReplacementForm((c) => ({ ...c, detail: event.target.value }))
                      : setFactForm((c) => ({ ...c, detail: event.target.value }))
                  }
                  aria-label="Détail du fait"
                />
              </label>
            </div>

            {formErrors.length > 0 && (
              <ul className="text-xs text-rose-700">
                {formErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            {actionError && <p className="text-xs text-rose-700">{actionError}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
                disabled={pendingAction === 'add-fact' || pendingAction === 'replace-fact'}
              >
                {replacing ? 'Remplacer le fait' : 'Ajouter le fait'}
              </button>
              {replacing && (
                <button
                  type="button"
                  className="rounded border border-slate-300 px-3 py-1 text-sm"
                  onClick={() => setReplacing(null)}
                >
                  Annuler
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
