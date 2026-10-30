import { z } from 'zod';
import { LLM_DIMENSIONS } from './dimensions.ts';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const text = z.string().trim().min(1).max(4000);
const statements = z.array(text).min(1).max(24);
export const EvidenceKindSchema = z.enum(['task', 'requirements', 'final-answer', 'rules', 'trace:<sequence>']);
export const RubricCriterionSchema = z.object({
  id, dimension: z.enum(LLM_DIMENSIONS), requirementRefs: z.array(id).min(1).max(32),
  processCriterionId: id.optional(), question: text,
  passAll: statements, failAny: statements, unknownWhen: statements,
  evidenceRequired: z.array(EvidenceKindSchema).min(1).max(5),
  boundaries: z.array(text).max(24).default([]),
}).strict().superRefine((v, ctx) => {
  if ((v.dimension === 'trajectory') !== Boolean(v.processCriterionId)) ctx.addIssue({code:'custom', message:'Only trajectory criteria must bind one processCriterionId'});
  if (new Set(v.requirementRefs).size !== v.requirementRefs.length || new Set(v.evidenceRequired).size !== v.evidenceRequired.length) ctx.addIssue({code:'custom', message:'Rubric references must be unique'});
});
export const StructuredRubricSchema = z.object({
  schemaVersion: z.literal('cwatch.eval-rubric.v1'), id, revision: z.number().int().positive(),
  policy: z.array(text).max(24).default([]), criteria: z.array(RubricCriterionSchema).min(1).max(64),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.criteria.map(c => c.id)).size !== v.criteria.length) ctx.addIssue({code:'custom', message:'Duplicate rubric criterion ID'});
  const process = v.criteria.flatMap(c => c.processCriterionId ? [c.processCriterionId] : []);
  if (new Set(process).size !== process.length) ctx.addIssue({code:'custom', message:'A process item must have exactly one rubric criterion'});
});
export type StructuredRubric = z.infer<typeof StructuredRubricSchema>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export function rubricDimensions(rubric: StructuredRubric | null) {
  return LLM_DIMENSIONS.filter(d => rubric?.criteria.some(c => c.dimension === d));
}
