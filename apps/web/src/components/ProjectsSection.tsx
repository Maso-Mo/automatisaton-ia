import { useState, type FormEvent } from 'react';
import type { ProjectInput, ProjectView, ProjectsVocabulary } from '../api/client';
import {
  emptyProjectForm,
  projectFormToInput,
  type ProjectFormState,
} from '../features/projects/forms';

/**
 * Liste des projets, avec la création sur place (docs/10 §4.2).
 *
 * Composant **présentationnel** : les données arrivent par les props, les
 * actions remontent par des callbacks. C'est ce qui permet de le rendre et de le
 * vérifier sans navigateur (`ProjectsSection.test.tsx`).
 */
export function ProjectsSection({
  projects,
  vocabulary,
  isLoading,
  isError,
  errorMessage,
  selectedId,
  showArchived,
  isCreating,
  createError,
  onToggleArchived,
  onSelect,
  onCreate,
}: {
  projects: ProjectView[];
  vocabulary: ProjectsVocabulary | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  selectedId: string | null;
  showArchived: boolean;
  isCreating: boolean;
  createError: string | null;
  onToggleArchived: (value: boolean) => void;
  onSelect: (projectId: string) => void;
  onCreate: (input: ProjectInput) => void;
}) {
  const [form, setForm] = useState<ProjectFormState>(emptyProjectForm);
  const [errors, setErrors] = useState<string[]>([]);

  const update = (patch: Partial<ProjectFormState>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const result = projectFormToInput(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    onCreate(result.value);
    setForm(emptyProjectForm);
  };

  const statusLabel = (status: string): string =>
    vocabulary?.projectStatuses.find((option) => option.value === status)?.label ?? status;

  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Projets</h2>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => onToggleArchived(event.target.checked)}
          />
          Afficher les projets archivés
        </label>
      </header>

      {isLoading && <p className="mt-2 text-sm text-slate-600">Chargement…</p>}
      {isError && (
        <p className="mt-2 text-sm text-rose-700">
          Liste des projets indisponible{errorMessage ? ` : ${errorMessage}` : '.'}
        </p>
      )}
      {!isLoading && !isError && projects.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">
          Aucun projet. Créer le premier ci-dessous — la mémoire se construit ensuite en faits.
        </p>
      )}
      {projects.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100">
          {projects.map((project) => {
            const isSelected = project.id === selectedId;
            return (
              <li key={project.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <button
                    type="button"
                    className={`text-left text-sm font-medium underline-offset-2 hover:underline ${
                      isSelected ? 'text-slate-900 underline' : 'text-slate-800'
                    }`}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => onSelect(project.id)}
                  >
                    {project.name}
                  </button>
                  <p className="text-xs text-slate-500">
                    {statusLabel(project.status)} ·{' '}
                    <span className="font-mono">{project.slug}</span>
                    {project.targetGoal ? ` · ${project.targetGoal}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  onClick={() => onSelect(project.id)}
                >
                  {isSelected ? 'Ouvert' : 'Détail'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form className="mt-4 border-t border-slate-100 pt-4" onSubmit={submit}>
        <h3 className="text-sm font-medium">Nouveau projet</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-slate-600">
            Nom *
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
              aria-label="Nom du projet"
            />
          </label>
          <label className="text-xs text-slate-600">
            Objectif
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              value={form.targetGoal}
              onChange={(event) => update({ targetGoal: event.target.value })}
              aria-label="Objectif"
            />
          </label>
          <label className="text-xs text-slate-600">
            Positionnement (une phrase)
            <input
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              value={form.positioning}
              onChange={(event) => update({ positioning: event.target.value })}
              aria-label="Positionnement"
            />
          </label>
          <label className="text-xs text-slate-600">
            Description (enregistrée comme fait)
            <textarea
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              rows={2}
              value={form.description}
              onChange={(event) => update({ description: event.target.value })}
              aria-label="Description"
            />
          </label>
        </div>

        {errors.length > 0 && (
          <ul className="mt-2 text-xs text-rose-700">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
        {createError && <p className="mt-2 text-xs text-rose-700">{createError}</p>}

        <button
          type="submit"
          className="mt-3 rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
          disabled={isCreating}
        >
          {isCreating ? 'Création…' : 'Créer le projet'}
        </button>
      </form>
    </section>
  );
}
