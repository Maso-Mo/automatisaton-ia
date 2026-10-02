import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, type ManualPackageView } from '../../api/client';
import { ProjectSelect } from '../../components/ProjectSelect';
import { ContentCard } from './ContentCard';
import { ContentDetailPanel } from './ContentDetailPanel';
import { JobProgressBar, useJobStream } from './JobProgressBar';
import { buildCards, describeApiError, groupBySection, reviewSummary } from './state';

/**
 * Écran « Revue » : relire, corriger, approuver ou rejeter — **par plateforme**.
 *
 * C'est le conteneur : il interroge l'API, actionne les mutations et suit le job
 * de régénération ; `ContentCard`, `ContentDetailPanel` et `JobProgressBar` ne
 * reçoivent que des props. Les décisions d'affichage (bouton actif, raison d'un
 * refus, compteurs) sont calculées par `state.ts`, testable sans navigateur.
 *
 * Aucune action n'est devinée : les boutons s'appuient sur les transitions servies
 * par l'API, et un bouton inactif affiche toujours **pourquoi** il l'est.
 */
export function ReviewView() {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountPlatform, setAccountPlatform] = useState<
    'linkedin' | 'reddit' | 'tiktok' | 'youtube'
  >('linkedin');
  const [accountLabel, setAccountLabel] = useState('');
  const [manualPackage, setManualPackage] = useState<ManualPackageView | null>(null);
  const [publicationAccountId, setPublicationAccountId] = useState('');

  const projects = useQuery({
    queryKey: ['projects', false],
    queryFn: () => api.projects(),
  });
  const vocabulary = useQuery({
    queryKey: ['editorial', 'vocabulary'],
    queryFn: api.editorialVocabulary,
    staleTime: 60_000,
  });
  const content = useQuery({
    queryKey: ['project-content', projectId, stateFilter],
    queryFn: () =>
      api.projectContent(projectId ?? '', stateFilter.length > 0 ? { state: stateFilter } : {}),
    enabled: projectId !== null,
  });
  const detail = useQuery({
    queryKey: ['content', selectedId],
    queryFn: () => api.contentDetail(selectedId ?? ''),
    enabled: selectedId !== null,
  });
  const accounts = useQuery({
    queryKey: ['platform-accounts', projectId],
    queryFn: () => api.platformAccounts(projectId ?? ''),
    enabled: projectId !== null,
  });

  // À la fin du job, on relit les contenus : c'est l'API qui dit l'état, jamais le
  // flux qui le suppose (le worker peut écrire après son dernier événement).
  const job = useJobStream(jobId, {
    onSettled: () => {
      setJobId(null);
      void queryClient.invalidateQueries({ queryKey: ['project-content', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['content', selectedId] });
    },
  });

  const vocabularyData = vocabulary.data;
  // Le contrôle local n'est rendu que pour le contenu **ouvert** : l'afficher sur
  // une carte fermée serait une affirmation que l'API n'a pas faite.
  const blockingIssues = useMemo(() => {
    if (selectedId === null || !detail.data?.validation) return {};
    return {
      [selectedId]: detail.data.validation.blocking.map(
        (issue) => `${issue.field} — ${issue.message}`,
      ),
    };
  }, [selectedId, detail.data]);

  const cards = useMemo(
    () =>
      vocabularyData ? buildCards(content.data?.content ?? [], vocabularyData, blockingIssues) : [],
    [content.data, vocabularyData, blockingIssues],
  );
  const summary = reviewSummary(cards);
  const selectedBundle = content.data?.content.find((bundle) => bundle.item.id === selectedId);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['project-content', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['content', selectedId] });
  };

  const accountAction = useMutation({
    mutationFn: () =>
      api.createPlatformAccount(projectId ?? '', {
        platform: accountPlatform,
        accountLabel: accountLabel.trim(),
      }),
    onSuccess: () => {
      setAccountLabel('');
      void queryClient.invalidateQueries({ queryKey: ['platform-accounts', projectId] });
    },
    onError: (cause: Error) => setError(describeApiError(cause)),
  });

  const packageAction = useMutation({
    mutationFn: (contentId: string) => api.createManualPackage(contentId),
    onSuccess: (result) => {
      setManualPackage(result.manualPackage);
      const matching = accounts.data?.accounts.find(
        (account) => account.platform === result.manualPackage.platform,
      );
      setPublicationAccountId(matching?.id ?? '');
    },
    onError: (cause: Error) => setError(describeApiError(cause)),
  });

  const publishAction = useMutation({
    mutationFn: () => api.markManualPackagePublished(manualPackage?.id ?? '', publicationAccountId),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['content', selectedId] });
    },
    onError: (cause: Error) => setError(describeApiError(cause)),
  });

  const copy = (value: unknown): void => {
    if (typeof value === 'string') void navigator.clipboard.writeText(value);
  };

  const packageBlock = (key: string): string => {
    const value = manualPackage?.copyBlocks[key];
    return typeof value === 'string' ? value : '';
  };

  const packageList = (key: string): string[] => {
    const value = manualPackage?.copyBlocks[key];
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
  };

  const action = useMutation({
    mutationFn: async (input: { itemId: string; run: () => Promise<unknown> }) => {
      setPending(input.itemId);
      setError(null);
      await input.run();
    },
    onSuccess: () => {
      setPending(null);
      refresh();
    },
    onError: (cause: Error) => {
      setPending(null);
      setError(describeApiError(cause));
    },
  });

  const regenerate = useMutation({
    mutationFn: (input: { itemId: string; instruction: string | null }) =>
      api.regenerateContent(input.itemId, input.instruction ?? undefined),
    onSuccess: (result) => {
      setJobId(result.jobId);
      setSelectedId(result.content.item.id);
      refresh();
    },
    onError: (cause: Error) => setError(describeApiError(cause)),
  });

  return (
    <section className="grid gap-4">
      <header className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-medium">Revue des contenus</h2>
        <p className="mt-1 text-sm text-slate-600">
          Une carte par plateforme : le texte, ses remarques, son budget de caractères et les
          décisions possibles. Rien ne se publie sans une approbation explicite.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProjectSelect
            projects={projects.data?.projects ?? []}
            value={projectId}
            label="Projet de la revue"
            onChange={(next) => {
              setProjectId(next);
              setSelectedId(null);
            }}
          />
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={stateFilter}
            aria-label="Filtrer par état"
            onChange={(event) => setStateFilter(event.target.value)}
          >
            <option value="">Tous les états</option>
            {(vocabularyData?.contentStates ?? []).map((state) => (
              <option key={state.value} value={state.value}>
                {state.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 text-sm"
            disabled={projectId === null}
            onClick={refresh}
          >
            Rafraîchir
          </button>
        </div>
        {cards.length > 0 && (
          <p className="mt-3 text-xs text-slate-600">
            {summary.total} contenu(s) · {summary.approved} approuvé(s) · {summary.rejected}{' '}
            rejeté(s) · {summary.pending} en attente
            {summary.withWarnings > 0 ? ` · ${summary.withWarnings} avec remarque` : ''}
          </p>
        )}
        {projectId !== null && (
          <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
            <h3 className="text-sm font-medium">Comptes de publication manuelle</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                aria-label="Plateforme du compte"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={accountPlatform}
                onChange={(event) =>
                  setAccountPlatform(event.target.value as typeof accountPlatform)
                }
              >
                <option value="linkedin">LinkedIn</option>
                <option value="reddit">Reddit</option>
                <option value="tiktok">TikTok</option>
                <option value="youtube">YouTube</option>
              </select>
              <input
                aria-label="Libellé du compte"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                placeholder="LinkedIn personnel"
                value={accountLabel}
                onChange={(event) => setAccountLabel(event.target.value)}
              />
              <button
                type="button"
                className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
                disabled={accountLabel.trim().length === 0 || accountAction.isPending}
                onClick={() => accountAction.mutate()}
              >
                Ajouter le compte
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              {(accounts.data?.accounts ?? []).map((account) => account.accountLabel).join(' · ') ||
                'Aucun compte configuré.'}
            </p>
          </div>
        )}
      </header>

      {job !== null && <JobProgressBar progress={job} title="Régénération en cours" />}

      {error !== null && (
        <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </p>
      )}

      {projectId === null && (
        <p className="text-sm text-slate-600">
          Choisir un projet pour voir ses contenus et les relire.
        </p>
      )}

      {projectId !== null && content.isPending && (
        <p className="text-sm text-slate-600">Chargement des contenus…</p>
      )}
      {projectId !== null && content.isError && (
        <p className="text-sm text-rose-700">{describeApiError(content.error)}</p>
      )}
      {projectId !== null && content.data && cards.length === 0 && (
        <p className="text-sm text-slate-600">
          Aucun contenu pour ce filtre — lancer une génération depuis l’onglet « Plan éditorial ».
        </p>
      )}

      {cards.length > 0 && vocabularyData && (
        <div className="grid gap-6">
          {groupBySection(cards, vocabularyData).map((section) => (
            <div key={section.key}>
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{section.label}</h3>
              {section.cards.length === 0 ? (
                <p className="text-xs text-slate-500">Aucun contenu généré pour cette cible.</p>
              ) : (
                <div className="grid gap-3">
                  {section.cards.map((card) => (
                    <ContentCard
                      key={card.itemId}
                      card={card}
                      vocabulary={vocabularyData}
                      busy={pending === card.itemId}
                      onOpenReview={() =>
                        action.mutate({
                          itemId: card.itemId,
                          run: async () => {
                            await api.markContentInReview(card.itemId);
                            setSelectedId(card.itemId);
                          },
                        })
                      }
                      onApprove={() =>
                        action.mutate({
                          itemId: card.itemId,
                          run: () => api.approveContent(card.itemId),
                        })
                      }
                      onRegenerate={(instruction) =>
                        regenerate.mutate({ itemId: card.itemId, instruction })
                      }
                      onEdit={(patch) =>
                        action.mutate({
                          itemId: card.itemId,
                          run: () =>
                            api.editContent(card.itemId, {
                              body: patch.body,
                              hook: patch.hook,
                              title: patch.title,
                              hashtags: card.hashtags,
                              author: 'user',
                            }),
                        })
                      }
                      onReject={(reason) =>
                        action.mutate({
                          itemId: card.itemId,
                          run: () => api.rejectContent(card.itemId, reason),
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {detail.data && vocabularyData && (
        <ContentDetailPanel detail={detail.data} vocabulary={vocabularyData} />
      )}
      {selectedBundle?.item.state === 'approved' && (
        <section className="rounded-lg border border-emerald-200 bg-white p-4">
          <h3 className="font-medium">Publication manuelle — niveau C</h3>
          <p className="mt-1 text-sm text-slate-600">
            Le paquet reste lié à la version approuvée exacte et ne déclenche aucun appel réseau
            social.
          </p>
          <button
            type="button"
            className="mt-3 rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={packageAction.isPending}
            onClick={() => packageAction.mutate(selectedBundle.item.id)}
          >
            Préparer le paquet manuel
          </button>
        </section>
      )}
      {manualPackage !== null && (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="font-medium">Paquet prêt — {manualPackage.platform}</h3>
          <p className="mt-1 text-xs text-slate-600">Version {manualPackage.contentVersionId}</p>
          <p className="mt-2 text-sm">{manualPackage.instructions}</p>
          {packageBlock('expectedMedia') && (
            <p className="mt-2 text-sm">
              <strong>Média attendu :</strong> {packageBlock('expectedMedia')}
            </p>
          )}
          {packageList('checklist').length > 0 && (
            <ul className="mt-2 list-inside list-disc text-sm text-slate-700">
              {packageList('checklist').map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
          {manualPackage.deepLink && (
            <a
              className="mt-2 inline-block text-sm text-blue-700 underline"
              href={manualPackage.deepLink}
              target="_blank"
              rel="noreferrer"
            >
              Ouvrir la plateforme
            </a>
          )}
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white p-3 text-sm">
            {manualPackage.body}
          </pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-sm"
              onClick={() => copy(manualPackage.body)}
            >
              Copier le texte
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-sm"
              disabled={!manualPackage.title}
              onClick={() => copy(manualPackage.title)}
            >
              Copier le titre
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-sm"
              disabled={!packageBlock('hook')}
              onClick={() => copy(packageBlock('hook'))}
            >
              Copier l’accroche
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-sm"
              onClick={() => copy(manualPackage.copyBlocks.description)}
            >
              Copier la description
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-sm"
              onClick={() => copy(manualPackage.copyBlocks.hashtags)}
            >
              Copier les hashtags
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-sm"
              disabled={!packageBlock('mentions')}
              onClick={() => copy(packageBlock('mentions'))}
            >
              Copier les mentions
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-label="Compte utilisé pour publier"
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
              value={publicationAccountId}
              onChange={(event) => setPublicationAccountId(event.target.value)}
            >
              <option value="">Choisir un compte</option>
              {(accounts.data?.accounts ?? [])
                .filter((account) => account.platform === manualPackage.platform)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountLabel}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="rounded bg-emerald-700 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={
                publicationAccountId.length === 0 ||
                publishAction.isPending ||
                manualPackage.markedPublishedAt !== null
              }
              onClick={() => publishAction.mutate()}
            >
              J’ai publié
            </button>
          </div>
        </section>
      )}
      {detail.isError && <p className="text-sm text-rose-700">{describeApiError(detail.error)}</p>}
    </section>
  );
}
