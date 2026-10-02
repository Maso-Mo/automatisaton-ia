import { useState } from 'react';
import type { AngleView, EditorialVocabulary, SubjectWithAngles } from '../../api/client';
import { labelOf } from './state';

/**
 * Les sujets proposés par le plan, avec leurs angles.
 *
 * Deux règles portées par cet écran :
 *
 * - **on choisit un angle, pas un sujet** (docs/03 §8.3) : le sujet est l'unité de
 *   sens, l'angle est le regard ; c'est l'angle que l'utilisateur retient ou
 *   écarte, avec une raison ;
 * - **on génère par cible** : une fois l'angle choisi, les plateformes se cochent et
 *   partent dans **un seul** job — l'angle est commun, les textes sont distincts.
 *
 * Composant présentatif : toutes les actions remontent au conteneur.
 */
export function SubjectPlanList({
  subjects,
  vocabulary,
  pending,
  onSelectAngle,
  onRejectAngle,
  onGenerate,
}: {
  subjects: SubjectWithAngles[];
  vocabulary: EditorialVocabulary;
  pending: boolean;
  onSelectAngle: (angleId: string, note: string | null) => void;
  onRejectAngle: (angleId: string, reason: string) => void;
  onGenerate: (angleId: string, targets: string[]) => void;
}) {
  if (subjects.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        Aucun sujet pour ce projet : produire un plan, ou en ajouter depuis la conversation.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      {subjects.map(({ subject, angles }) => (
        <section key={subject.id} className="rounded-lg border border-slate-200 bg-white p-4">
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">{subject.title}</h3>
            <span className="flex gap-2 text-xs">
              <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
                {labelOf(vocabulary.subjectStatuses, subject.status)}
              </span>
              {subject.pillar !== null && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
                  {subject.pillar}
                </span>
              )}
              {subject.priorityScore !== null && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
                  priorité {Math.round(subject.priorityScore)}
                </span>
              )}
            </span>
          </header>

          <p className="mt-1 text-sm text-slate-700">{subject.thesis}</p>

          {subject.evidence.length > 0 && (
            <ul className="mt-2 space-y-1">
              {subject.evidence.map((item) => (
                <li key={item} className="rounded bg-slate-50 p-2 text-xs text-slate-600">
                  Source : {item}
                </li>
              ))}
            </ul>
          )}

          {subject.skillCoverage !== null && (
            <p className="mt-2 text-xs text-slate-600">
              {labelOf(vocabulary.skillCoverages, subject.skillCoverage)}
            </p>
          )}

          <div className="mt-3 grid gap-3">
            {angles.map((angle) => (
              <AngleRow
                key={angle.id}
                angle={angle}
                vocabulary={vocabulary}
                pending={pending}
                onSelect={onSelectAngle}
                onReject={onRejectAngle}
                onGenerate={onGenerate}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Un angle : son accroche, son type, sa structure, et les deux décisions possibles.
 *
 * L'état local de la ligne (cibles cochées, motif de rejet, note) est **local** :
 * rien n'est envoyé tant que l'utilisateur n'a pas cliqué. C'est ce qui permet de
 * cocher trois plateformes et de tout générer en un job, ou de changer d'avis.
 */
function AngleRow({
  angle,
  vocabulary,
  pending,
  onSelect,
  onReject,
  onGenerate,
}: {
  angle: AngleView;
  vocabulary: EditorialVocabulary;
  pending: boolean;
  onSelect: (angleId: string, note: string | null) => void;
  onReject: (angleId: string, reason: string) => void;
  onGenerate: (angleId: string, targets: string[]) => void;
}) {
  const [targets, setTargets] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [panel, setPanel] = useState<'none' | 'reject'>('none');

  const toggleTarget = (key: string): void => {
    setTargets((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  return (
    <article
      className={`rounded border p-3 ${
        angle.selected ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200'
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-sm">{angle.hook}</p>
        <span className="flex gap-2 text-xs">
          <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
            {labelOf(vocabulary.angleTypes, angle.angleType)}
          </span>
          <span className="text-slate-500">{angle.platform}</span>
          {angle.score !== null && <span className="text-slate-500">score {angle.score}</span>}
        </span>
      </header>

      {angle.rationale !== null && <p className="mt-1 text-xs text-slate-600">{angle.rationale}</p>}

      {angle.structure.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-700">
          {angle.structure.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}

      {angle.evidence.length > 0 && (
        <p className="mt-2 text-xs text-slate-600">
          Faits mobilisés : {angle.evidence.join(' · ')}
        </p>
      )}

      {angle.rejectionReason !== null && (
        <p className="mt-2 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
          Angle écarté : {angle.rejectionReason}
        </p>
      )}

      {angle.selected && (
        <div className="mt-3">
          <p className="text-xs text-slate-700">
            Angle retenu — cocher les plateformes à produire (un seul lot, un seul job) :
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            {vocabulary.targets.map((target) => (
              <label key={target.key} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={targets.includes(target.key)}
                  onChange={() => toggleTarget(target.key)}
                />
                {target.label}
                <span className="text-slate-500">
                  ({target.bodyTargetChars}/{target.bodyMaxChars})
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={pending || targets.length === 0}
            onClick={() => onGenerate(angle.id, targets)}
          >
            Générer {targets.length > 0 ? `${targets.length} contenu(s)` : ''}
          </button>
        </div>
      )}

      {!angle.selected && angle.rejectionReason === null && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded bg-emerald-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={pending}
            onClick={() => onSelect(angle.id, note.trim().length > 0 ? note.trim() : null)}
          >
            Retenir cet angle
          </button>
          <input
            className="rounded border border-slate-300 px-2 py-1 text-xs"
            placeholder="note (facultative)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            className="rounded border border-rose-300 px-3 py-1 text-sm text-rose-700"
            disabled={pending}
            onClick={() => setPanel((current) => (current === 'reject' ? 'none' : 'reject'))}
          >
            Écarter
          </button>
        </div>
      )}

      {panel === 'reject' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="rounded border border-rose-300 px-2 py-1 text-xs"
            placeholder="Pourquoi cet angle ne convient pas"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className="rounded bg-rose-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={pending || reason.trim().length === 0}
            onClick={() => {
              onReject(angle.id, reason.trim());
              setReason('');
              setPanel('none');
            }}
          >
            Écarter cet angle
          </button>
        </div>
      )}
    </article>
  );
}
