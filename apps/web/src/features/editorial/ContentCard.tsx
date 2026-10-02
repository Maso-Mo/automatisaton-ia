import { useState } from 'react';
import { formatRelative, type EditorialVocabulary } from '../../api/client';
import type { EditorialCard } from './state';

/**
 * Une carte = **une plateforme**. C'est la règle de l'écran : on ne relit pas
 * « un contenu », on relit un post LinkedIn ou un script YouTube — les budgets de
 * forme, les remarques et la décision sont propres à la cible (docs/03 §9.1).
 *
 * Le composant est **présentatif** : il n'appelle pas l'API et ne décide de rien.
 * Les actions remontent au conteneur ; les raisons de refus, elles, sont déjà
 * calculées par le domaine de l'écran (`state.ts`) et affichées telles quelles.
 */
export function ContentCard({
  card,
  vocabulary,
  busy,
  onOpenReview,
  onApprove,
  onRegenerate,
  onEdit,
  onReject,
}: {
  card: EditorialCard;
  vocabulary: EditorialVocabulary;
  busy: boolean;
  onOpenReview: () => void;
  onApprove: () => void;
  onRegenerate: (instruction: string | null) => void;
  onEdit: (patch: { body: string; title: string | null; hook: string | null }) => void;
  onReject: (reason: string) => void;
}) {
  const [panel, setPanel] = useState<'none' | 'regenerate' | 'edit' | 'reject'>('none');
  const [instruction, setInstruction] = useState('');
  const [reason, setReason] = useState('');
  const [body, setBody] = useState(card.body);
  const [hook, setHook] = useState(card.hook ?? '');
  const [title, setTitle] = useState(card.title ?? '');

  const over = card.overflowChars > 0;
  const ratio = Math.round(card.charRatio * 100);

  const openPanel = (next: 'regenerate' | 'edit' | 'reject'): void => {
    if (next === 'edit') {
      setBody(card.body);
      setHook(card.hook ?? '');
      setTitle(card.title ?? '');
    }
    setPanel((current) => (current === next ? 'none' : next));
  };

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-medium">{card.targetLabel}</h3>
          <p className="text-xs text-slate-500">
            {card.versionLabel} · {card.stateLabel} · modifié {formatRelative(card.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`rounded px-2 py-0.5 ${
              card.approved
                ? 'bg-emerald-100 text-emerald-800'
                : card.rejected
                  ? 'bg-rose-100 text-rose-800'
                  : 'bg-slate-100 text-slate-700'
            }`}
          >
            {card.approved ? 'Approuvé' : card.rejected ? 'Rejeté' : card.stateLabel}
          </span>
          {card.regeneratedCount > 0 && (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
              {card.regeneratedCount}/{vocabulary.limits.maxRegenerationsPerItem} régénérations
            </span>
          )}
          {card.editRatio !== null && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">
              édité à {Math.round(card.editRatio * 100)} %
            </span>
          )}
        </div>
      </header>

      {card.rejectionReason !== null && (
        <p className="mt-2 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
          Rejeté : {card.rejectionReason}
        </p>
      )}

      {/* Le budget de caractères est celui de la cible : le dépassement se voit ici,
          avant l'appel, pas dans un message d'erreur après coup. */}
      <p className={`mt-2 text-xs ${over ? 'text-rose-700' : 'text-slate-600'}`}>
        {card.charCount} / {card.charBudget} caractères ({ratio} %)
        {over ? ` — dépassement de ${card.overflowChars}` : ''}
      </p>

      {card.hook !== null && card.hook.length > 0 && (
        <p className="mt-2 text-sm italic text-slate-700">« {card.hook} »</p>
      )}

      {card.blockingIssues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {card.blockingIssues.map((issue) => (
            <li
              key={issue}
              className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
            >
              {issue}
            </li>
          ))}
        </ul>
      )}

      {card.notes.length > 0 && (
        <ul className="mt-2 space-y-1">
          {card.notes.map((note) => (
            <li
              key={note.id}
              className={`rounded border p-2 text-xs ${
                note.tone === 'danger'
                  ? 'border-rose-200 bg-rose-50 text-rose-800'
                  : note.tone === 'warning'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-slate-200 bg-slate-50 text-slate-700'
              }`}
            >
              <strong>{note.typeLabel}</strong> · {note.severityLabel} — {note.message}
              {note.anchorText ? ` (« ${note.anchorText} »)` : ''}
            </li>
          ))}
        </ul>
      )}

      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 font-sans text-sm text-slate-800">
        {card.body.length > 0 ? card.body : 'Aucune version pour l’instant.'}
      </pre>

      <div className="mt-3 flex flex-wrap gap-2">
        {!card.inReview && card.canReject && (
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 text-sm"
            disabled={busy}
            onClick={onOpenReview}
          >
            Ouvrir la relecture
          </button>
        )}
        {card.inReview && card.approvalBlockedReason?.includes('Relancer les contrôles') && (
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 text-sm"
            disabled={busy}
            onClick={onOpenReview}
          >
            Relancer les contrôles
          </button>
        )}
        <button
          type="button"
          className="rounded bg-emerald-600 px-3 py-1 text-sm text-white disabled:opacity-50"
          disabled={busy || !card.canApprove}
          title={card.approvalBlockedReason ?? 'Approuver cette version'}
          onClick={onApprove}
        >
          Approuver
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
          disabled={busy || !card.canRegenerate}
          title={card.regenerateBlockedReason ?? 'Régénérer cette plateforme'}
          onClick={() => openPanel('regenerate')}
        >
          Régénérer
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
          disabled={busy || !card.canEdit}
          title={card.editBlockedReason ?? 'Modifier le texte à la main'}
          onClick={() => openPanel('edit')}
        >
          Modifier
        </button>
        <button
          type="button"
          className="rounded border border-rose-300 px-3 py-1 text-sm text-rose-700 disabled:opacity-50"
          disabled={busy || !card.canReject}
          onClick={() => openPanel('reject')}
        >
          Rejeter
        </button>
      </div>

      {/* Un bouton désactivé dit **pourquoi** : c'est ce qui évite le clic dans le vide. */}
      {!card.canApprove && card.approvalBlockedReason !== null && (
        <p className="mt-2 text-xs text-slate-600">Approbation : {card.approvalBlockedReason}</p>
      )}
      {!card.canRegenerate && card.regenerateBlockedReason !== null && (
        <p className="mt-1 text-xs text-slate-600">Régénération : {card.regenerateBlockedReason}</p>
      )}
      {card.canRegenerate && card.regenerationsLeft === 1 && (
        <p className="mt-1 text-xs text-amber-700">
          Il reste une seule régénération avant le plafond.
        </p>
      )}

      {panel === 'regenerate' && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
          <label className="block text-xs text-slate-600" htmlFor={`instruction-${card.itemId}`}>
            Consigne (facultative) — elle est transmise telle quelle au modèle
          </label>
          <textarea
            id={`instruction-${card.itemId}`}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
            rows={2}
            maxLength={600}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={busy || (instruction.length > 0 && instruction.trim().length < 4)}
              onClick={() => {
                onRegenerate(instruction.trim().length > 0 ? instruction.trim() : null);
                setInstruction('');
                setPanel('none');
              }}
            >
              Régénérer cette plateforme
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1 text-sm"
              onClick={() => setPanel('none')}
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {panel === 'edit' && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs text-slate-600">
            Le texte est remplacé <strong>en entier</strong> : ce qui est enregistré est ce qui est
            envoyé.
          </p>
          <label className="mt-2 block text-xs text-slate-600" htmlFor={`hook-${card.itemId}`}>
            Accroche
          </label>
          <input
            id={`hook-${card.itemId}`}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
            value={hook}
            maxLength={600}
            onChange={(event) => setHook(event.target.value)}
          />
          <label className="mt-2 block text-xs text-slate-600" htmlFor={`body-${card.itemId}`}>
            Corps du texte ({body.length} caractères)
          </label>
          <textarea
            id={`body-${card.itemId}`}
            className="mt-1 h-48 w-full rounded border border-slate-300 p-2 text-sm"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={busy || body.trim().length === 0}
              onClick={() => {
                onEdit({ body, title: title.trim().length > 0 ? title : null, hook });
                setPanel('none');
              }}
            >
              Enregistrer une nouvelle version
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1 text-sm"
              onClick={() => setPanel('none')}
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {panel === 'reject' && (
        <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-3">
          <label className="block text-xs text-rose-800" htmlFor={`reason-${card.itemId}`}>
            Motif du rejet (obligatoire) : c’est ce qui s’apprend pour la suite
          </label>
          <textarea
            id={`reason-${card.itemId}`}
            className="mt-1 w-full rounded border border-rose-300 p-2 text-sm"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded bg-rose-600 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={busy || reason.trim().length === 0}
              onClick={() => {
                onReject(reason.trim());
                setReason('');
                setPanel('none');
              }}
            >
              Rejeter ce contenu
            </button>
            <button
              type="button"
              className="rounded border border-rose-300 px-3 py-1 text-sm text-rose-800"
              onClick={() => setPanel('none')}
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
