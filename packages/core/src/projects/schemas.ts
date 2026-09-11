import {
  ValidationError,
  factCategorySchema,
  factSourceSchema,
  factVerificationStatusSchema,
  projectStatusSchema,
} from '@aia/shared';
import { z } from 'zod';

/**
 * Vocabulaire d'entrée du domaine « projets » : ce qui est **valide** avant
 * d'entrer dans une règle métier (docs/03 §2.5 : « un JSON libre non validé est
 * un bug silencieux »).
 *
 * Ces schémas vivent dans le domaine et non dans l'API : la route les applique,
 * elle ne les réinvente pas. Un champ accepté par l'API mais refusé par le
 * domaine — ou l'inverse — devient impossible.
 */

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
);

const optionalInt = z.coerce.number().int().optional();
const optionalBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const createProjectBodySchema = z.object({
  name: z.string().min(1),
  positioning: z.string().nullable().optional(),
  targetGoal: z.string().nullable().optional(),
  language: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).nullable().optional(),
  startDate: z.number().int().nullable().optional(),
  /** Première description : enregistrée en fait de catégorie `description`. */
  description: z.string().min(1).optional(),
});
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

export const updateProjectBodySchema = z.object({
  name: z.string().min(1).optional(),
  positioning: z.string().nullable().optional(),
  targetGoal: z.string().nullable().optional(),
  language: z.string().min(2).max(10).optional(),
  timezone: z.string().nullable().optional(),
  startDate: z.number().int().nullable().optional(),
  status: projectStatusSchema.optional(),
});
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;

export const addFactBodySchema = z.object({
  category: factCategorySchema,
  statement: z.string().min(1),
  detail: z.string().nullable().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  source: factSourceSchema.optional(),
  verificationStatus: factVerificationStatusSchema.optional(),
  verificationNote: z.string().nullable().optional(),
});
export type AddFactBody = z.infer<typeof addFactBodySchema>;

export const updateFactBodySchema = z.object({
  category: factCategorySchema.optional(),
  statement: z.string().min(1).optional(),
  detail: z.string().nullable().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  verificationNote: z.string().nullable().optional(),
});
export type UpdateFactBody = z.infer<typeof updateFactBodySchema>;

export const verificationBodySchema = z.object({
  status: factVerificationStatusSchema,
  note: z.string().nullable().optional(),
});
export type VerificationBody = z.infer<typeof verificationBodySchema>;

export const replaceFactBodySchema = addFactBodySchema.extend({
  /** Note expliquant le remplacement, conservée sur l'ancien fait. */
  note: z.string().nullable().optional(),
});
export type ReplaceFactBody = z.infer<typeof replaceFactBodySchema>;

export const listProjectsQuerySchema = z.object({
  status: csv.pipe(z.array(projectStatusSchema)).optional(),
  includeArchived: optionalBoolean,
  limit: optionalInt,
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export const factListQuerySchema = z.object({
  category: csv.pipe(z.array(factCategorySchema)).optional(),
  status: csv.pipe(z.array(factVerificationStatusSchema)).optional(),
  since: optionalInt,
  until: optionalInt,
  includeInactive: optionalBoolean,
  limit: optionalInt,
});
export type FactListQuery = z.infer<typeof factListQuerySchema>;

export const contextQuerySchema = z.object({
  category: csv.pipe(z.array(factCategorySchema)).optional(),
  status: csv.pipe(z.array(factVerificationStatusSchema)).optional(),
  since: optionalInt,
  until: optionalInt,
  includeUnverified: optionalBoolean,
  limit: optionalInt,
});
export type ContextQuery = z.infer<typeof contextQuerySchema>;

/** Applique un schéma et transforme l'échec en erreur typée `validation` (HTTP 400). */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, code = 'REQUEST_INVALID'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new ValidationError('Requête invalide', {
    code,
    details: {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}
