/**
 * Sélecteur de projet, partagé par les écrans de l'étape 5.
 *
 * Il est **présentatif** : il ne charge rien et ne connaît ni l'API ni React Query.
 * La valeur `null` est l'absence de choix (« choisir un projet… ») — jamais une
 * chaîne vide, qui serait un identifiant valide en apparence et inexistant en base.
 */
export function ProjectSelect({
  projects,
  value,
  onChange,
  label = 'Projet',
  disabled = false,
}: {
  projects: Array<{ id: string; name: string }>;
  value: string | null;
  onChange: (projectId: string | null) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
      value={value ?? ''}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">Choisir un projet…</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
