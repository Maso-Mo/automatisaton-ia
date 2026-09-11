/**
 * `@aia/shared` — types, contrats et utilitaires purs.
 *
 * Ce paquet ne dépend **d'aucun** autre paquet du projet et ne connaît aucune
 * infrastructure (docs/02 §5). Il est importable par tout le monde, y compris
 * par les paquets d'infrastructure que `packages/core` ne peut pas importer.
 */

export * from './contracts';
export * from './enums';
export * from './errors';
export * from './ids';
export * from './json';
export * from './money';
export * from './ports';
export * from './time';
