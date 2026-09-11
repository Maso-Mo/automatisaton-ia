import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  formatRelative,
  type ConversationView as ConversationRecord,
  type EditPlanView,
  type MasterBriefView,
  type MessageView,
} from '../../api/client';
import {
  briefMissingLabels,
  defaultSelection,
  formatTurnCost,
  mergeMessages,
  pendingProposals,
  planProposals,
  stageSummary,
} from './state';

/**
 * Écran « Conversation » de l'étape 3 : discuter par texte avec l'assistant,
 * accepter ou refuser les écritures proposées, et construire la fiche maître.
 *
 * Deux choix d'interface, tous deux imposés par le domaine :
 *
 * 1. **les propositions sont visibles avant d'entrer en mémoire** : chacune
 *    affiche la citation qui la justifie, et rien n'est écrit sans un clic ;
 * 2. **la fiche maître est relue avant d'être validée** : la validation est un
 *    acte humain daté, et une correction crée une nouvelle version.
 */

type ConversationTab = 'conversation' | 'brief';

export function ConversationView() {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [tab, setTab] = useState<ConversationTab>('conversation');
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmFacts, setConfirmFacts] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveMessages, setLiveMessages] = useState<MessageView[]>([]);
  const [live, setLive] = useState<{ stage: string; nextSlot: string | null } | null>(null);
  const lastAssistant = useRef<string | null>(null);

  const projects = useQuery({ queryKey: ['projects', false], queryFn: () => api.projects({}) });
  const conversations = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => api.conversations(projectId ? { projectId } : {}),
    enabled: projectId !== null,
  });
  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversation(conversationId ?? ''),
    enabled: conversationId !== null,
  });

  const conversation: ConversationRecord | undefined = detail.data?.conversation;
  const messages = useMemo(
    () => mergeMessages(detail.data?.messages ?? [], liveMessages),
    [detail.data?.messages, liveMessages],
  );
  const brief = detail.data?.briefs.at(-1) ?? null;
  const assistantPlan = useMemo(() => lastPlan(messages, lastAssistant.current), [messages]);
  const nextSlot = live?.nextSlot ?? detail.data?.nextSlot ?? null;

  // Un nouveau plan présélectionne ce qui est **cité**, jamais ce qui est refusé.
  useEffect(() => {
    if (!assistantPlan) return;
    setSelected(defaultSelection(assistantPlan));
  }, [assistantPlan]);

  /** Flux SSE reprenable : l'état complet d'abord, puis les incréments (docs/02 §13). */
  useEffect(() => {
    if (conversationId === null) return;
    setLiveMessages([]);
    const source = new EventSource(
      `/api/events/conversations/${encodeURIComponent(conversationId)}`,
    );

    source.addEventListener('snapshot', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        messages: MessageView[];
        conversation: ConversationRecord;
      };
      setLiveMessages(payload.messages);
      setLive({
        stage: payload.conversation.stage,
        nextSlot: payload.conversation.missingSlots[0] ?? null,
      });
    });
    source.addEventListener('message', (event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as MessageView;
      setLiveMessages((current) => mergeMessages(current, [message]));
    });
    source.addEventListener('progress', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        stage: string;
        nextSlot: string | null;
      };
      setLive({ stage: payload.stage, nextSlot: payload.nextSlot });
    });

    return () => source.close();
  }, [conversationId]);

  const createConversation = useMutation({
    mutationFn: (id: string) => api.createConversation({ projectId: id }),
    onSuccess: (result) => {
      setConversationId(result.conversation.id);
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const send = useMutation({
    mutationFn: (content: string) => api.sendMessage(conversationId ?? '', { content }),
    onSuccess: (result) => {
      setDraft('');
      lastAssistant.current = result.message.id;
      setLiveMessages((current) => mergeMessages(current, [result.userMessage, result.message]));
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const accept = useMutation({
    mutationFn: (messageId: string) =>
      api.applyProposals(conversationId ?? '', messageId, { accept: selected, confirmFacts }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const makeBrief = useMutation({
    mutationFn: () => api.generateBrief(conversationId ?? ''),
    onSuccess: () => {
      setTab('brief');
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const validateBrief = useMutation({
    mutationFn: (briefId: string) => api.validateBrief(briefId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  return (
    <section className="grid gap-6">
      <header className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-medium">Conversation</h2>
        <p className="mt-1 text-sm text-slate-600">
          Parlez de votre projet : l’assistant pose la question qui manque, propose des faits avec
          leur citation, et rien n’entre en mémoire sans votre accord.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={projectId ?? ''}
            aria-label="Projet"
            onChange={(event) => {
              setProjectId(event.target.value || null);
              setConversationId(null);
            }}
          >
            <option value="">Choisir un projet…</option>
            {(projects.data?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>

          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={conversationId ?? ''}
            aria-label="Conversation"
            onChange={(event) => setConversationId(event.target.value || null)}
          >
            <option value="">Reprendre un entretien…</option>
            {(conversations.data?.conversations ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {(item.title ?? 'Entretien sans titre') + ` · ${item.messageCount} messages`}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={projectId === null || createConversation.isPending}
            onClick={() => projectId && createConversation.mutate(projectId)}
          >
            Nouvel entretien
          </button>

          {conversation && (
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
              disabled={makeBrief.isPending}
              onClick={() => makeBrief.mutate()}
            >
              {brief ? 'Régénérer la fiche maître' : 'Générer la fiche maître'}
            </button>
          )}

          {conversation && (
            <nav className="ml-auto flex gap-1" aria-label="Volets">
              {(['conversation', 'brief'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded px-2 py-1 text-xs ${
                    tab === value ? 'bg-slate-900 text-white' : 'border border-slate-300'
                  }`}
                  onClick={() => setTab(value)}
                >
                  {value === 'conversation' ? 'Échanges' : 'Fiche maître'}
                </button>
              ))}
            </nav>
          )}
        </div>

        {conversation && (
          <p className="mt-3 text-xs text-slate-500">
            {stageSummary(
              live?.stage ?? conversation.stage,
              nextSlot,
              detail.data?.slotLabels ?? {},
            )}
            {' · '}
            {conversation.messageCount} messages
          </p>
        )}

        {error && (
          <p className="mt-2 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
            {error}
            <button type="button" className="ml-2 underline" onClick={() => setError(null)}>
              masquer
            </button>
          </p>
        )}
      </header>

      {conversationId === null ? (
        <p className="text-sm text-slate-600">
          Choisissez un projet, puis créez un entretien : aucune question ne portera sur ce que la
          mémoire du projet contient déjà.
        </p>
      ) : tab === 'conversation' ? (
        <>
          <ol className="grid gap-2" aria-label="Messages">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </ol>

          {assistantPlan && pendingProposals(assistantPlan).length > 0 && (
            <ProposalPanel
              plan={assistantPlan}
              selected={selected}
              confirmFacts={confirmFacts}
              pending={accept.isPending}
              onToggle={(id) =>
                setSelected((current) =>
                  current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
                )
              }
              onConfirmFacts={setConfirmFacts}
              onAccept={() => accept.mutate(assistantPlan.assistantMessageId)}
            />
          )}

          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim().length === 0) return;
              send.mutate(draft);
            }}
          >
            <textarea
              className="min-h-24 rounded border border-slate-300 p-2 text-sm"
              placeholder="Répondez à la question, ou racontez ce que vous avez fait…"
              value={draft}
              maxLength={8_000}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
                disabled={send.isPending || draft.trim().length === 0}
              >
                {send.isPending ? 'Réponse en cours…' : 'Envoyer'}
              </button>
              {send.isPending && (
                <span className="text-xs text-slate-500">
                  Votre message est déjà enregistré : un échec d’appel ne coûte rien à retenter.
                </span>
              )}
              {send.data && (
                <span className="text-xs text-slate-500">
                  Dernier échange :{' '}
                  {formatTurnCost(
                    send.data.usage.costMicroUsd,
                    send.data.usage.inputTokens,
                    send.data.usage.outputTokens,
                  )}
                  {send.data.repaired ? ' · sortie réparée' : ''}
                </span>
              )}
            </div>
          </form>
        </>
      ) : (
        <BriefPanel
          brief={brief}
          validating={validateBrief.isPending}
          onValidate={(id) => validateBrief.mutate(id)}
        />
      )}
    </section>
  );
}

/** Dernier message de l'assistant porteur d'un plan : c'est lui qui attend une décision. */
function lastPlan(messages: readonly MessageView[], preferred: string | null): EditPlanView | null {
  const candidates = [...messages]
    .reverse()
    .filter((message) => message.role === 'assistant' && message.contentJson?.plan);
  const match = preferred ? candidates.find((message) => message.id === preferred) : undefined;
  const chosen = match ?? candidates[0];
  return chosen?.contentJson?.plan ?? null;
}

function MessageBubble({ message }: { message: MessageView }) {
  const isUser = message.role === 'user';
  return (
    <li
      className={`rounded-lg border p-3 text-sm ${
        isUser ? 'border-slate-300 bg-white' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-medium">{isUser ? 'Vous' : 'Assistant'}</span>
        <span>{formatRelative(message.createdAt)}</span>
        {!isUser && message.costMicroUsd > 0 && (
          <span className="ml-auto">
            {formatTurnCost(message.costMicroUsd, message.tokensIn ?? 0, message.tokensOut ?? 0)}
          </span>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-slate-800">{message.content}</p>
    </li>
  );
}

function ProposalPanel(props: {
  plan: EditPlanView;
  selected: readonly string[];
  confirmFacts: boolean;
  pending: boolean;
  onToggle(id: string): void;
  onConfirmFacts(value: boolean): void;
  onAccept(): void;
}) {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <h3 className="text-sm font-medium text-amber-900">
        Écritures proposées : rien n’est en mémoire tant que vous n’acceptez pas
      </h3>
      <ul className="mt-2 grid gap-2">
        {planProposals(props.plan).map((proposal) => (
          <li key={proposal.id} className="rounded border border-amber-200 bg-white p-2 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={props.selected.includes(proposal.id)}
                disabled={proposal.rejectedReason !== null}
                onChange={() => props.onToggle(proposal.id)}
              />
              <span>
                <span className="font-medium">{proposal.label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  « {proposal.sourceQuote} »
                </span>
                {proposal.rejectedReason !== null && (
                  <span className="mt-0.5 block text-xs text-rose-700">
                    refusée : {proposal.rejectedReason}
                  </span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={props.confirmFacts}
            onChange={(event) => props.onConfirmFacts(event.target.checked)}
          />
          confirmer immédiatement les faits acceptés (sinon ils restent « proposés »)
        </label>
        <button
          type="button"
          className="ml-auto rounded bg-amber-800 px-3 py-1 text-sm text-white disabled:opacity-50"
          disabled={props.pending || props.selected.length === 0}
          onClick={props.onAccept}
        >
          Accepter la sélection
        </button>
      </div>
    </section>
  );
}

function BriefPanel(props: {
  brief: MasterBriefView | null;
  validating: boolean;
  onValidate(id: string): void;
}) {
  if (!props.brief) {
    return (
      <p className="text-sm text-slate-600">
        Aucune fiche maître pour cet entretien. Elle se génère depuis l’onglet « Échanges », une
        fois le positionnement et le public connus.
      </p>
    );
  }

  const brief = props.brief;
  const statusLabel =
    brief.status === 'validated' ? 'validée' : brief.status === 'draft' ? 'brouillon' : 'remplacée';
  const missing = briefMissingLabels(
    [
      brief.formats === null ? 'formats' : '',
      brief.cadence === null ? 'cadence' : '',
      brief.successCriteria === null ? 'success_criteria' : '',
    ].filter((value) => value.length > 0),
  );

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Fiche maître v{brief.version}</h3>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{statusLabel}</span>
        {brief.validatedAt !== null && (
          <span className="text-xs text-slate-500">
            validée {formatRelative(brief.validatedAt)}
          </span>
        )}
        {brief.status === 'draft' && (
          <button
            type="button"
            className="ml-auto rounded bg-emerald-700 px-3 py-1 text-xs text-white disabled:opacity-50"
            disabled={props.validating}
            onClick={() => props.onValidate(brief.id)}
          >
            Valider cette version
          </button>
        )}
      </header>

      <dl className="mt-3 grid gap-2">
        <BriefRow label="Synthèse" value={brief.summary} />
        <BriefRow label="Positionnement" value={brief.positioning} />
        <BriefRow label="Public visé" value={brief.targetAudience} />
        <BriefRow label="Piliers de contenu" value={brief.contentPillars.join(' · ')} />
        <BriefRow label="Thèmes" value={brief.themes.join(' · ')} />
        <BriefRow
          label="Formats"
          value={
            brief.formats === null
              ? null
              : brief.formats
                  .map((item) => `${item.platform} : ${item.formats.join(', ')}`)
                  .join(' · ')
          }
        />
        <BriefRow
          label="Rythme"
          value={
            brief.cadence === null
              ? null
              : brief.cadence.map((item) => `${item.platform} ${item.perWeek}/sem`).join(' · ')
          }
        />
        <BriefRow
          label="Ce qui n’est pas maîtrisé (utilisé en négatif)"
          value={brief.gaps === null ? null : brief.gaps.join(' · ')}
        />
        <BriefRow
          label="Critères de réussite"
          value={brief.successCriteria === null ? null : brief.successCriteria.join(' · ')}
        />
      </dl>

      {missing.length > 0 && (
        <p className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          À compléter : {missing.join(', ')} — l’intervieweur posera la question, l’écran ne devine
          rien.
        </p>
      )}
    </article>
  );
}

function BriefRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-slate-800">
        {value === null || value.trim().length === 0 ? (
          <span className="text-amber-700">à compléter</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
