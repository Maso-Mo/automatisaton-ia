import { contentStateSchema, contentTargetSchema, subjectStatusSchema } from '@aia/shared';
import { z } from 'zod';

/**
 * Entrées du domaine « éditorial » : ce qui est **valide** avant d'entrer dans
 * une règle métier. Ces schémas vivent dans le domaine et non dans l'API : la
 * route les applique, elle ne les réinvente pas (console identique pour
 * `apps/api`, les tests et, demain, la CLI).
 */

/** Un texte de plateforme tient dans 8 000 caractères : au-delà, c'est un document. */
export const CONTENT_BODY_MAX_LENGTH = 8_000;
/** Un motif de rejet est court : c'est une raison, pas une dissertation. */
export const REJECT_REASON_MAX_LENGTH = 500;

export const subjectListQuerySchema = z.object({
  status: subjectStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type SubjectListQuery = z.infer<typeof subjectListQuerySchema>;

export const contentListQuerySchema = z.object({
  state: contentStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ContentListQuery = z.infer<typeof contentListQuerySchema>;

/**
 * « Générer » : **un angle sélectionné** et **au moins une cible**.
 *
 * Le schéma refuse un lot vide : générer zéro texte est une erreur d'appel, pas
 * une intention. Les doublons de cibles sont retirés par le domaine
 * (`sortContentTargets`), qui est aussi ce qui fixe l'ordre.
 */
export const generateContentBodySchema = z.object({
  angleId: z.string().min(1),
  targets: z.array(contentTargetSchema).min(1).max(5),
});
export type GenerateContentBody = z.infer<typeof generateContentBodySchema>;

/**
 * « Régénérer » : le contenu désigné par l'URL, et une consigne facultative.
 *
 * La cible n'est **pas** dans le corps : elle est celle du contenu, lue en base.
 * L'accepter depuis le client permettrait de demander la réécriture d'un contenu
 * dans le format d'une autre plateforme, ce que rien ne saurait interpréter
 * (docs/05 §4.4). La consigne, elle, est transmise telle quelle : c'est la parole
 * de l'utilisateur, et le produit ne la réécrit pas.
 */
export const regenerateContentBodySchema = z.object({
  instruction: z.string().min(4).max(600).nullable().optional(),
});
export type RegenerateContentBody = z.infer<typeof regenerateContentBodySchema>;

/** Sélection d'un angle : elle ne porte aucune donnée, seulement une décision. */
export const selectAngleBodySchema = z.object({
  /** Remarque facultative attachée au choix (pourquoi cet angle-là). */
  note: z.string().min(1).max(REJECT_REASON_MAX_LENGTH).nullable().optional(),
});
export type SelectAngleBody = z.infer<typeof selectAngleBodySchema>;

export const rejectAngleBodySchema = z.object({
  reason: z.string().min(1).max(REJECT_REASON_MAX_LENGTH).nullable().optional(),
});
export type RejectAngleBody = z.infer<typeof rejectAngleBodySchema>;

/**
 * Édition manuelle : le corps est remplacé **en entier**, pas rapiécé.
 *
 * Une édition partielle (« remplace juste cette phrase ») demanderait des
 * ancres, donc un diff ; ce n'est pas ce que le produit promet. Ce que
 * l'utilisateur voit dans la zone de texte est ce qui est enregistré.
 */
export const editContentBodySchema = z.object({
  body: z.string().min(1).max(CONTENT_BODY_MAX_LENGTH),
  title: z.string().max(300).nullable().optional(),
  hook: z.string().max(600).nullable().optional(),
  hashtags: z.array(z.string().min(1).max(80)).max(20).optional(),
  mentions: z.array(z.string().min(1).max(80)).max(20).optional(),
  /** Auteur de la modification : `user` en V1, jamais un agent. */
  author: z.string().min(1).max(60).optional(),
});
export type EditContentBody = z.infer<typeof editContentBodySchema>;

export const approveContentBodySchema = z.object({
  /** Qui approuve. `null` = approbation implicite de l'utilisateur du produit. */
  approvedBy: z.string().min(1).max(120).nullable().optional(),
});
export type ApproveContentBody = z.infer<typeof approveContentBodySchema>;

export const rejectContentBodySchema = z.object({
  reason: z.string().min(1).max(REJECT_REASON_MAX_LENGTH),
  author: z.string().min(1).max(60).optional(),
});
export type RejectContentBody = z.infer<typeof rejectContentBodySchema>;
