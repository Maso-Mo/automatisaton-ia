#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/verify.sh — vérification complète, à lancer avant un commit de fin de
# journée (docs/09 §13.2). Le pré-commit ne fait que la partie rapide ; tout le
# reste est ici, en local, sans service distant.
#
# Ordre : types → lint → tests → parcours → migrations → frontières → secrets.
# Une seule commande qui échoue arrête tout (set -e).
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  printf '\n\033[1m▶ %s\033[0m\n' "$1"
}

step 'types (tsc strict)'
pnpm typecheck

step 'lint (ESLint)'
pnpm lint

step 'tests (unitaires + intégration, hors suite live)'
pnpm test

step 'parcours de bout en bout'
pnpm test:e2e

step 'migrations (base vide + base peuplée)'
pnpm db:check-migrations

step 'frontières d’architecture (sens des dépendances, cycles)'
pnpm check:boundaries

step 'aucun secret dans les journaux (canari)'
pnpm check:canary

step 'environnement local'
pnpm check:env

printf '\n\033[1;32m✅ pnpm verify : tout est vert\033[0m\n'
