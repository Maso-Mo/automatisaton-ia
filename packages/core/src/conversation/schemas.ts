import {
  conversationKindSchema,
  messageInputModeSchema,
  platformIdSchema,
  skillLevelSchema,
} from '@aia/shared';
import { z } from 'zod';

/**
 * Entrées du domaine « conversation » : ce qui est **valide** avant d'entrer
 * dans une règle métier. Ces schémas vivent dans le domaine et non dans l'API :
 * la route les applique, elle ne les réinvente pas (console identique pour
 * `apps/api` et pour les tests).
 */

/** Un message utilisateur n'est pas un document : 8 000 caractères suffisent. */
export const MESSAGE_MAX_LENGTH = 8_000;

export const createConversationBodySchema = z.object({
  projectId: z.string().min(1),
  kind: conversationKindSchema.optional(),
  title: z.string().min(1).max(200).nullable().optional(),
});
export type CreateConversationBody = z.infer<typeof createConversationBodySchema>;

export const postMessageBodySchema = z.object({
  content: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  inputMode: messageInputModeSchema.optional(),
});
export type PostMessageBody = z.infer<typeof postMessageBodySchema>;

/** Décisions sur les propositions d'un message : accepter, et éventuellement confirmer. */
export const proposalDecisionBodySchema = z.object({
  accept: z.array(z.string().min(1)).max(32).default([]),
  confirmFacts: z.boolean().optional(),
});
export type ProposalDecisionBody = z.infer<typeof proposalDecisionBodySchema>;

export const conversationListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const messageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2_000).optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

export const closeConversationBodySchema = z.object({
  closed: z.boolean().default(true),
});
export type CloseConversationBody = z.infer<typeof closeConversationBodySchema>;

/**
 * Correction de la fiche maître : chaque champ est optionnel, et `null` est
 * **significatif** (« ce bloc n'existe pas »), d'où le `.nullable()` explicite
 * plutôt qu'un `undefined` ambigu.
 */
export const briefEditBodySchema = z.object({
  summary: z.string().min(1).max(2_000).optional(),
  positioning: z.string().min(1).max(600).optional(),
  targetAudience: z.string().min(1).max(1_000).optional(),
  contentPillars: z.array(z.string().min(2).max(160)).min(2).max(5).optional(),
  themes: z.array(z.string().min(2).max(200)).min(1).max(12).optional(),
  formats: z
    .array(
      z.object({
        platform: platformIdSchema,
        formats: z.array(z.string().min(1).max(60)).min(1).max(8),
      }),
    )
    .max(8)
    .nullable()
    .optional(),
  skillMap: z
    .array(
      z.object({
        skill: z.string().min(2).max(120),
        level: skillLevelSchema,
        isLearning: z.boolean().default(false),
      }),
    )
    .max(24)
    .nullable()
    .optional(),
  gaps: z.array(z.string().min(2).max(200)).max(16).nullable().optional(),
  cadence: z
    .array(z.object({ platform: platformIdSchema, perWeek: z.number().int().min(0).max(21) }))
    .max(8)
    .nullable()
    .optional(),
  successCriteria: z.array(z.string().min(2).max(200)).max(8).nullable().optional(),
});
export type BriefEditBody = z.infer<typeof briefEditBodySchema>;
