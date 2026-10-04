import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatRelative, type DiagnosticsView } from '../api/client';
import { getAuthToken, setAuthToken } from '../api/authToken';

/**
 * Panneau d'exploitation (étape 12 §14 et §22).
 *
 * Il répond aux questions qu'on se pose *après* la mise en route : reste-t-il de
 * la place ? quand a-t-on sauvegardé ? des jobs échouent-ils ? quels services
 * sont configurés ? L'API ne renvoie jamais une valeur de secret, seulement sa
 * *présence* (`configured`) : l'écran ne peut donc pas la divulguer.
 *
 * Le champ de jeton n'est pas un identifiant utilisateur : c'est la barrière de
 * périmètre, définie côté serveur (`AUTH_TOKEN`), devenue nécessaire dès qu'on
 * quitte `localhost` (téléphone sur le Wi-Fi, tunnel Tailscale — docs/11).
 */

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 o';
  const units = ['o', 'ko', 'Mo', 'Go', 'To'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function DiskBar({ disk }: { disk: DiagnosticsView['disk'][number] }) {
  const danger = disk.usedPercent >= 95;
  const warn = !danger && disk.usedPercent >= 85;
  const color = danger ? 'bg-rose-600' : warn ? 'bg-amber-500' : 'bg-emerald-600';
  return (
    <div className="rounded border border-slate-200 p-3">
      <p className="truncate font-mono text-xs text-slate-600" title={disk.path}>
        {disk.path}
      </p>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-200"
        role="progressbar"
        aria-valuenow={disk.usedPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Occupation de ${disk.path}`}
      >
        <div className={`h-full ${color}`} style={{ width: `${disk.usedPercent}%` }} />
      </div>
      <p className="mt-1 text-sm text-slate-700">
        {disk.usedPercent} % occupé · {formatBytes(disk.freeBytes)} libres sur{' '}
        {formatBytes(disk.totalBytes)}
      </p>
      {danger && (
        <p className="mt-1 text-xs text-rose-700">
          Presque plein : purger les médias inutilisés avant la prochaine génération.
        </p>
      )}
    </div>
  );
}

function AuthTokenForm() {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(getAuthToken());
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="rounded border border-slate-200 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setAuthToken(value);
        setSaved(true);
        // Le jeton change ce que le serveur accepte : on relance les requêtes.
        void queryClient.invalidateQueries();
      }}
    >
      <label className="block text-sm font-medium" htmlFor="auth-token">
        Jeton d’accès (AUTH_TOKEN)
      </label>
      <p className="mt-1 text-xs text-slate-600">
        À renseigner <strong>uniquement</strong> si l’API a été configurée avec un jeton —
        obligatoire dès qu’on accède à l’application autrement que depuis la machine locale. Laisser
        vide en accès local.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id="auth-token"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
          }}
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 font-mono text-sm"
          placeholder="vide = pas de jeton"
        />
        <button
          type="submit"
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white hover:bg-slate-700"
        >
          Enregistrer
        </button>
      </div>
      {saved && (
        <p className="mt-2 text-xs text-emerald-700">
          Jeton enregistré sur cet appareil (jamais affiché, jamais journalisé).
        </p>
      )}
    </form>
  );
}

export function DiagnosticsPanel() {
  const [open, setOpen] = useState(false);
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: api.diagnostics,
    refetchInterval: 15_000,
  });

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Exploitation</h2>
        <button
          type="button"
          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Replier' : 'Déplier'}
        </button>
      </div>

      {!open && (
        <p className="mt-1 text-sm text-slate-600">
          Disque, dernière sauvegarde, jobs en échec, services configurés et accès distant.
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-4">
          {diagnostics.isPending && <p className="text-sm text-slate-600">Lecture…</p>}

          {diagnostics.isError && (
            <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {diagnostics.error.message}
            </p>
          )}

          {diagnostics.data && <DiagnosticsBody data={diagnostics.data} />}
        </div>
      )}
    </section>
  );
}

/** Corps du panneau : uniquement des faits lus sur l'API, aucune estimation. */
function DiagnosticsBody({ data }: { data: DiagnosticsView }) {
  return (
    <>
      <div>
        <h3 className="text-sm font-medium text-slate-700">Espace disque</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {data.disk.map((disk) => (
            <DiskBar key={disk.path} disk={disk} />
          ))}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-slate-200 p-3">
          <h3 className="text-sm font-medium text-slate-700">Sauvegardes</h3>
          {data.lastBackup ? (
            <p className="mt-1 text-sm text-slate-700">
              Dernière : {data.lastBackup.label} ({formatRelative(data.lastBackup.createdAt)}) ·{' '}
              {formatBytes(data.lastBackup.sizeBytes)} · sha256{' '}
              <span className="font-mono">{data.lastBackup.checksum.slice(0, 12)}…</span> ·{' '}
              {data.backupCount} sauvegarde(s)
            </p>
          ) : (
            <p className="mt-1 text-sm text-amber-700">
              Aucune sauvegarde : lancer <code className="rounded bg-white px-1">pnpm backup</code>.
            </p>
          )}
        </div>

        <div className="rounded border border-slate-200 p-3">
          <h3 className="text-sm font-medium text-slate-700">Jobs en échec</h3>
          <p className="mt-1 text-sm text-slate-700">
            {data.failedJobs === 0
              ? 'Aucun échec enregistré.'
              : `${data.failedJobs} job(s) en échec ou mort — visibles dans la section Jobs.`}
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-slate-700">Services</h3>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {data.services.map((service) => (
            <li
              key={service.id}
              className={`rounded border p-3 ${
                service.configured
                  ? 'border-emerald-200 bg-emerald-50'
                  : 'border-amber-200 bg-amber-50'
              }`}
            >
              <p className="text-sm font-medium">
                <span aria-hidden>{service.configured ? '✅' : '⚠️'}</span> {service.label}
              </p>
              <p className="mt-1 text-xs text-slate-700">{service.detail}</p>
              {!service.configured && service.optional && (
                <p className="mt-1 text-xs text-amber-800">
                  Optionnel : seule la fonctionnalité correspondante est indisponible.
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-medium text-slate-700">Accès distant</h3>
        <div className="mt-2">
          <AuthTokenForm />
        </div>
      </div>
    </>
  );
}
