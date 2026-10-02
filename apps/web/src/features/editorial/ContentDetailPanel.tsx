import type { ContentDetailView, EditorialVocabulary } from '../../api/client';
import { formatRelative } from '../../api/client';
import { compareWithApproved, versionOptions } from './state';

/**
 * Le détail d'**un** contenu : le contrôle local recalculé par le serveur, la
 * comparaison avec la version approuvée, et l'historique complet.
 *
 * Trois raisons de montrer ces trois blocs ensemble :
 *
 * - le contrôle local n'est **pas stocké** : il est recalculé à la lecture, donc
 *   afficher ce que le serveur vient de dire est la seule vérité (docs/05 §4.5) ;
 * - après une régénération, la question est « qu'est-ce qui a changé ? » — d'où la
 *   comparaison côte à côte avec la version approuvée, jamais une simple liste ;
 * - l'historique rend le retour en arrière possible et lisible : une version
 *   n'est jamais écrasée (docs/03 §9.2).
 */
export function ContentDetailPanel({
  detail,
  vocabulary,
}: {
  detail: ContentDetailView;
  vocabulary: EditorialVocabulary;
}) {
  const validation = detail.validation;
  const versions = versionOptions(
    detail.history.versions,
    detail.history.currentVersionId,
    detail.history.approvedVersionId,
    vocabulary,
  );
  const compared = compareWithApproved(
    detail.history.versions,
    detail.history.currentVersionId,
    detail.history.approvedVersionId,
  );

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="font-medium">Détail du contenu</h3>
      <p className="mt-1 text-xs text-slate-500">
        {detail.history.versions.length} version(s) · contrôle local recalculé à la lecture
      </p>

      {validation === null ? (
        <p className="mt-2 text-sm text-slate-600">
          Aucune version : le contrôle local s’appliquera dès la première génération.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm">
            <strong className={validation.ok ? 'text-emerald-700' : 'text-rose-700'}>
              {validation.ok ? 'Conforme aux bornes de la cible' : 'Non conforme'}
            </strong>{' '}
            · {validation.stats.charCount} caractères, {validation.stats.wordCount} mots,{' '}
            {validation.stats.readingTimeSec} s de lecture, {validation.stats.hashtags} mot(s)-dièse
            {validation.stats.chapters > 0 ? `, ${validation.stats.chapters} chapitre(s)` : ''}
          </p>

          {validation.blocking.length > 0 && (
            <ul className="mt-2 space-y-1">
              {validation.blocking.map((issue) => (
                <li
                  key={`${issue.code}-${issue.field}`}
                  className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
                >
                  <strong>{issue.field}</strong> — {issue.message}
                </li>
              ))}
            </ul>
          )}

          {validation.warnings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {validation.warnings.map((issue) => (
                <li
                  key={`${issue.code}-${issue.field}`}
                  className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
                >
                  <strong>{issue.field}</strong> — {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h4 className="mt-4 text-sm font-medium">Affirmations factuelles</h4>
      {detail.content.claims.length === 0 ? (
        <p className="mt-1 text-xs text-slate-600">Aucune affirmation factuelle extraite.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {detail.content.claims.map((claim) => (
            <li
              key={claim.id}
              className={`rounded border p-2 text-xs ${
                claim.risk === 'eleve' && claim.status !== 'supported'
                  ? 'border-rose-200 bg-rose-50 text-rose-800'
                  : 'border-slate-200 bg-slate-50 text-slate-700'
              }`}
            >
              <strong>{claim.status}</strong> · risque {claim.risk} — {claim.claim}
              {claim.evidence ? ` · preuve ${claim.evidence}` : ''}
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-4 text-sm font-medium">Comparaison avec la version approuvée</h4>
      {compared.approved === null ? (
        <p className="mt-1 text-xs text-slate-600">
          Aucune version approuvée : rien à comparer pour l’instant.
        </p>
      ) : (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div>
            <p className="text-xs text-slate-500">Approuvée (v{compared.approved.versionNumber})</p>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-emerald-50 p-2 font-sans text-xs text-slate-800">
              {compared.approved.body}
            </pre>
          </div>
          <div>
            <p className="text-xs text-slate-500">
              Courante ({compared.current ? `v${compared.current.versionNumber}` : 'aucune'})
            </p>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-xs text-slate-800">
              {compared.current?.body ?? 'Aucune version courante.'}
            </pre>
          </div>
        </div>
      )}

      <h4 className="mt-4 text-sm font-medium">Historique des versions</h4>
      <ul className="mt-2 space-y-1">
        {versions.length === 0 && (
          <li className="text-xs text-slate-600">Aucune version enregistrée.</li>
        )}
        {versions.map((version) => (
          <li
            key={version.id}
            className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-slate-100 p-2 text-xs"
          >
            <span>
              <strong>{version.label}</strong> · {formatRelative(version.createdAt)}
              {version.charCount !== null ? ` · ${version.charCount} caractères` : ''}
            </span>
            <span className="text-slate-500">
              {version.isCurrent ? 'courante' : ''}
              {version.isCurrent && version.isApproved ? ' · ' : ''}
              {version.isApproved ? 'approuvée' : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
