import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type FactInput, type ProjectInput } from '../../api/client';
import { ProjectDetailSection, type FactFilters } from '../../components/ProjectDetailSection';
import { ProjectsSection } from '../../components/ProjectsSection';

/**
 * Écran « Projets » de l'étape 2 : liste, création, détail, édition, faits.
 *
 * C'est le **conteneur** : il interroge l'API et actionne les mutations ; les
 * composants d'affichage ne connaissent que des props (`ProjectsSection`,
 * `ProjectDetailSection`). Cette séparation permet de tester la logique de
 * saisie sans navigateur et de rendre les composants hors DOM.
 */
export function ProjectsView() {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FactFilters>({
    category: '',
    status: '',
    includeInactive: false,
  });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const vocabulary = useQuery({
    queryKey: ['projects', 'vocabulary'],
    queryFn: api.projectsVocabulary,
    staleTime: 60_000,
  });

  const projects = useQuery({
    queryKey: ['projects', showArchived],
    queryFn: () => api.projects({ includeArchived: showArchived }),
  });

  const detail = useQuery({
    queryKey: ['project', selectedId],
    queryFn: () => api.project(selectedId ?? ''),
    enabled: selectedId !== null,
  });

  const facts = useQuery({
    queryKey: ['project-facts', selectedId, filters],
    queryFn: () =>
      api.projectFacts(selectedId ?? '', {
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.includeInactive ? { includeInactive: true } : {}),
      }),
    enabled: selectedId !== null,
  });

  const refresh = (projectId: string | null): void => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    if (projectId) {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-facts', projectId] });
    }
  };

  const run = async (label: string, projectId: string | null, action: () => Promise<unknown>) => {
    setPendingAction(label);
    setActionError(null);
    try {
      await action();
      refresh(projectId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action refusée');
    } finally {
      setPendingAction(null);
    }
  };

  const createProject = useMutation({
    mutationFn: (input: ProjectInput) => api.createProject(input),
    onSuccess: (result) => {
      setCreateError(null);
      setSelectedId(result.project.id);
      refresh(result.project.id);
    },
    onError: (error: Error) => setCreateError(error.message),
  });

  return (
    <>
      <ProjectsSection
        projects={projects.data?.projects ?? []}
        vocabulary={vocabulary.data}
        isLoading={projects.isPending}
        isError={projects.isError}
        errorMessage={projects.error?.message ?? null}
        selectedId={selectedId}
        showArchived={showArchived}
        isCreating={createProject.isPending}
        createError={createError}
        onToggleArchived={setShowArchived}
        onSelect={setSelectedId}
        onCreate={(input) => createProject.mutate(input)}
      />

      {selectedId === null && (
        <p className="text-sm text-slate-600">
          Choisir un projet pour consulter sa mémoire — identité, faits, informations encore
          manquantes.
        </p>
      )}

      {selectedId !== null && (
        <ProjectDetailSection
          detail={detail.data}
          facts={facts.data?.facts ?? []}
          vocabulary={vocabulary.data}
          isLoading={detail.isPending}
          isError={detail.isError}
          errorMessage={detail.error?.message ?? null}
          isLoadingFacts={facts.isPending}
          filters={filters}
          pendingAction={pendingAction}
          actionError={actionError}
          onFilterChange={setFilters}
          onEditProject={(input) =>
            void run('edit-project', selectedId, () => api.updateProject(selectedId, input))
          }
          onArchiveProject={() =>
            void run('archive', selectedId, () => api.archiveProject(selectedId))
          }
          onAddFact={(input) =>
            void run('add-fact', selectedId, () => api.addFact(selectedId, input))
          }
          onSetFactVerification={(factId, status, note) =>
            void run(factId, selectedId, () =>
              api.setFactVerification(selectedId, factId, { status, note }),
            )
          }
          onReplaceFact={(factId, input: FactInput & { note: string | null }) =>
            void run('replace-fact', selectedId, () => api.replaceFact(selectedId, factId, input))
          }
        />
      )}
    </>
  );
}
