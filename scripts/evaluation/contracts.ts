import { z } from 'zod';
import { DecisionSchema } from '@cwatch/core/types';
import { OUTPUT_CONTRACTS } from './output-format.ts';
import { ReportContractSchema } from './report-format.ts';
import { EVAL_DIMENSION_IDS, CODE_DIMENSIONS, PROCESS_SCORING_ITEMS, type EvalDimension } from './dimensions.ts';
import { StructuredRubricSchema } from './rubric.ts';
import { FrozenSkillSchema } from './skill-snapshots.ts';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const json = z.json();
const requirement = z.object({ id, assertion: z.string().min(1) }).strict();
const processCriterion=z.object({id,item:z.enum(PROCESS_SCORING_ITEMS),unitId:id,requirementRefs:z.array(id).min(1),expectation:z.string().min(1)}).strict();
const tool = z.object({ name: id, action: z.enum(['collect', 'modify']), behavior: z.enum(['return', 'hang', 'cancel', 'throw']).default('return'), value: json.default({ ok: true }),
  description: z.string().min(1).max(4000).optional(), inputSchema: z.record(z.string(), json).optional(), requires: id.optional(),
}).strict();
export const CoverageSchema = z.object({ category: z.enum(EVAL_DIMENSION_IDS), polarity: z.enum(['positive', 'negative']),
  target: z.enum(['tool_activation', 'runtime_contract', 'markdown_report']),
}).strict();
export const ScenarioSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('runtime'), instruction: z.string().min(1), source: z.enum(['github_api', 'fixture', 'none']),
    response: z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()), body: json }).strict().optional(),
    tools: z.array(tool).max(8).default([]), steps: z.array(DecisionSchema).max(16).default([]),
    selectedSkills:z.array(FrozenSkillSchema).max(8).default([]),
    modelMode:z.enum(['scripted','pi_session']).default('scripted'),maxTokens:z.number().int().min(1024).max(80000).default(30000),
    outputContract:z.enum(OUTPUT_CONTRACTS).optional(),
    maxOutputTokens:z.number().int().min(256).max(8192).default(2048),
    permission: z.enum(['explore', 'ask']).default('explore'), approvalAnswers: z.array(z.boolean()).max(8).default([]),
    toolTimeoutMs: z.number().int().min(10).max(5000).default(500), maxToolCalls: z.number().int().min(1).max(32).default(12),
  }).strict().superRefine((v,ctx) => {
    if (v.source === 'github_api' && !v.response) ctx.addIssue({ code:'custom', message:'github_api requires a frozen response' });
    if(v.source==='none'&&(v.tools.length||v.response))ctx.addIssue({code:'custom',message:'No-source scenarios cannot register fixture/API tools'});
    if(new Set(v.selectedSkills.map(s=>s.name)).size!==v.selectedSkills.length)ctx.addIssue({code:'custom',message:'Duplicate selected Skill'});
    if(v.modelMode==='scripted'&&!v.steps.length)ctx.addIssue({code:'custom',message:'scripted model requires steps'});
    if(v.modelMode==='pi_session'&&v.steps.length)ctx.addIssue({code:'custom',message:'live model cannot receive a scripted answer trajectory'});
    if (new Set(v.tools.map(t=>t.name)).size !== v.tools.length) ctx.addIssue({ code:'custom', message:'duplicate fixture tool' });
    if (v.tools.some(t => t.requires && (t.requires === t.name || !v.tools.some(other => other.name === t.requires)))) ctx.addIssue({ code: 'custom', message: 'invalid tool prerequisite' });
  }),
  z.object({ driver: z.literal('memory'), responses: z.array(z.enum(['stop', 'length', 'invalid'])).min(1).max(3), seedCheckpoint: z.boolean().default(false),
    cancelAfterResponse: z.boolean().default(false), denyRecoveryBudget: z.boolean().default(false), maxOutputTokens: z.number().int().min(1024).max(4096).default(2048),
  }).strict(),
  z.object({ driver: z.literal('discovery'), referenceUrls: z.array(z.string().url()).min(1).max(8), allowedDomains: z.array(z.string().min(1)).min(1).max(8),
    searchUrls: z.array(z.string().url()).max(16), readableUrls: z.array(z.string().url()).max(8),
  }).strict(),
]);
export const InputSchema = z.object({ scenario: ScenarioSchema, materialProvenance: z.string().min(1) }).strict();
export type EvalInput = z.infer<typeof InputSchema>;
export const CheckSchema = z.object({ id, requirementRefs: z.array(id).min(1),
  dimension:z.enum(CODE_DIMENSIONS).optional(),
  method: z.enum(['equals', 'at_most', 'non_empty_string', 'trace_valid', 'file_boundary', 'no_canary_leak']),
  path: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional(), expected: json.optional(),
  required: z.boolean(), hardFail: z.boolean(), failureCode: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
}).strict().superRefine((v,ctx) => {
  if (v.method === 'equals' && (!v.path || !Object.hasOwn(v,'expected'))) ctx.addIssue({code:'custom',message:'equals requires path and expected'});
  if (v.method === 'at_most' && (!v.path || typeof v.expected!=='number' || !Number.isFinite(v.expected) || v.expected<0)) ctx.addIssue({code:'custom',message:'at_most requires path and a finite nonnegative numeric limit'});
  if (v.method === 'non_empty_string' && (!v.path || Object.hasOwn(v,'expected'))) ctx.addIssue({code:'custom',message:'non_empty_string requires path and no expected value'});
  if (v.path?.split('.').some(p=>['__proto__','prototype','constructor'].includes(p))) ctx.addIssue({code:'custom',message:'unsafe selector'});
  if (v.hardFail && !v.required) ctx.addIssue({code:'custom',message:'hard failure must be required'});
});
export const CaseSchema = z.object({ schemaVersion: z.literal('cwatch.eval-case.v5'), id, revision: z.number().int().positive(), familyId:id, title:z.string().min(1),
  coverage: CoverageSchema.optional(),
  status:z.enum(['needs_review','approved','retired']), split:z.enum(['regression','holdout']),
  scope:z.object({level:z.enum(['component','runtime','agent']),executionMode:z.enum(['deterministic','frozen_tools_live_model'])}).strict(),
  origin:z.object({layer:z.enum(['manual','observed_failure','synthetic']),environment:z.enum(['authored','development_acceptance','production']),
    originalRunId:z.string().min(1).nullable(), parentCaseIds:z.array(id), author:z.string().min(1)}).strict(),
  oracle:z.object({references:z.array(z.string().min(1)).min(1),knownLimits:z.array(z.string()),review:z.object({by:z.string().min(1),kind:z.literal('human'),at:z.string().datetime({offset:true})}).strict().nullable()}).strict(),
  input:InputSchema,
  rubric:StructuredRubricSchema.nullable(),
  humanReview:z.object({dimensions:z.array(z.enum(['trajectory','safety'])).max(2)}).strict(),
  expected_final:z.object({allowedRunStatuses:z.array(z.enum(['complete','partial','failed','cancelled'])).min(1),outputContract:z.enum(OUTPUT_CONTRACTS).optional(),reportContract:ReportContractSchema.optional(),requirements:z.array(requirement).min(1)}).strict(),
  expected_process:z.object({requirements:z.array(requirement),criteria:z.array(processCriterion).max(64)}).strict(),
  expected_evidence:z.object({requirements:z.array(requirement)}).strict().default({requirements:[]}),
  expected_cost:z.object({requirements:z.array(requirement)}).strict().default({requirements:[]}),
  safety_boundaries:z.object({requirements:z.array(requirement).min(1)}).strict(),
  scoring:z.object({checks:z.array(CheckSchema),aggregation:z.literal('all_required_pass_no_hard_fail')}).strict(),
  failure_taxonomy:z.object({allowedCodes:z.array(z.string()).min(1)}).strict(),
}).strict().superRefine((v,ctx) => {
  const reqs=[...v.expected_final.requirements,...v.expected_process.requirements,...v.expected_evidence.requirements,...v.safety_boundaries.requirements,...v.expected_cost.requirements];
  const ids=new Set(reqs.map(r=>r.id)),checks=new Set(v.scoring.checks.map(c=>c.id));
  const ownerById=new Map<string,EvalDimension>([
    ...v.expected_final.requirements.map(r=>[r.id,'outcome'] as const),...v.expected_process.requirements.map(r=>[r.id,'trajectory'] as const),
    ...v.expected_evidence.requirements.map(r=>[r.id,'evidence'] as const),...v.safety_boundaries.requirements.map(r=>[r.id,'safety'] as const),
    ...v.expected_cost.requirements.map(r=>[r.id,'cost'] as const),
  ]);
  if(ids.size!==reqs.length||checks.size!==v.scoring.checks.length)ctx.addIssue({code:'custom',message:'duplicate requirement/check id'});
  const processIds=new Set(v.expected_process.requirements.map(r=>r.id)),criteria=v.expected_process.criteria;
  if(new Set(criteria.map(c=>c.id)).size!==criteria.length || new Set(criteria.map(c=>c.item+':'+c.unitId)).size!==criteria.length)ctx.addIssue({code:'custom',message:'process criteria and item/unit pairs must be unique'});
  if(criteria.some(c=>c.requirementRefs.some(ref=>!processIds.has(ref)))||[...processIds].some(ref=>!criteria.some(c=>c.requirementRefs.includes(ref))))ctx.addIssue({code:'custom',message:'every process requirement needs a declared scoring criterion; references must stay in trajectory'});
  if(new Set(v.humanReview.dimensions).size!==v.humanReview.dimensions.length)ctx.addIssue({code:'custom',message:'Human review dimensions must be unique'});
  if(v.humanReview.dimensions.includes('trajectory') !== (criteria.length>0))ctx.addIssue({code:'custom',message:'Human trajectory review must match declared process criteria'});
  const rubricCriteria=v.rubric?.criteria??[];
  for(const c of rubricCriteria){
    if(c.requirementRefs.some(ref=>ownerById.get(ref)!==c.dimension))ctx.addIssue({code:'custom',message:'Rubric criterion must reference requirements of its own dimension: '+c.id});
    if(c.dimension==='trajectory'){
      const process=criteria.find(p=>p.id===c.processCriterionId);
      if(!process||process.requirementRefs.length!==c.requirementRefs.length||process.requirementRefs.some(ref=>!c.requirementRefs.includes(ref)))ctx.addIssue({code:'custom',message:'Rubric trajectory binding must match the declared process item: '+c.id});
    }
  }
  if(criteria.some(p=>!rubricCriteria.some(c=>c.processCriterionId===p.id)))ctx.addIssue({code:'custom',message:'Every process scoring item needs an explicit structured rubric criterion'});
  for(const c of v.scoring.checks){
    const owners=new Set(c.requirementRefs.map(ref=>ownerById.get(ref)).filter(Boolean));
    if(owners.has('trajectory'))ctx.addIssue({code:'custom',message:'Trajectory is graded by Rubric and human; code records its Trace evidence, not a score'});
    if(owners.size>1 || (c.dimension && !owners.has(c.dimension)))ctx.addIssue({code:'custom',message:'check must reference requirements from exactly its declared dimension'});
    if(c.method==='trace_valid'&&!owners.has('evidence'))ctx.addIssue({code:'custom',message:'trace integrity belongs to evidence requirements'});
    if(['file_boundary','no_canary_leak'].includes(c.method)&&!owners.has('safety'))ctx.addIssue({code:'custom',message:'boundary checks belong to safety requirements'});
    if(c.requirementRefs.some(r=>!ids.has(r)))ctx.addIssue({code:'custom',message:'unknown requirement reference: '+c.id});
    if(!v.failure_taxonomy.allowedCodes.includes(c.failureCode))ctx.addIssue({code:'custom',message:'unregistered failure code: '+c.id});
  }
  const semanticCovered=new Set(rubricCriteria.flatMap(c=>c.requirementRefs));
  if(v.humanReview.dimensions.includes('safety'))v.safety_boundaries.requirements.forEach(r=>semanticCovered.add(r.id));
  const covered=new Set([...v.scoring.checks.flatMap(c=>c.requirementRefs),...semanticCovered]);
  for(const r of [...v.expected_final.requirements,...v.expected_evidence.requirements,...v.safety_boundaries.requirements]){
    if(!semanticCovered.has(r.id)&&!v.scoring.checks.some(c=>c.requirementRefs.includes(r.id)&&(c.required||c.hardFail)))ctx.addIssue({code:'custom',message:'P0 requirements need an assigned semantic reviewer or required code check: '+r.id});
  }
  if([...ids].some(r=>ownerById.get(r)!=='trajectory'&&!covered.has(r)))ctx.addIssue({code:'custom',message:'Requirement has no assigned grader'});
  if(v.status==='approved'&&!v.oracle.review)ctx.addIssue({code:'custom',message:'approved case requires a recorded human review'});
  if(v.origin.layer==='observed_failure'&&!v.origin.originalRunId)ctx.addIssue({code:'custom',message:'observed failure requires original run identity'});
  if(v.origin.layer==='synthetic'&&!v.origin.parentCaseIds.length)ctx.addIssue({code:'custom',message:'synthetic case requires lineage'});
  const realModel=v.input.scenario.driver==='runtime'&&v.input.scenario.modelMode==='pi_session';
  if(v.input.scenario.driver==='runtime'&&v.input.scenario.outputContract!==undefined)ctx.addIssue({code:'custom',message:'declare outputContract only in expected_final; execution input is generated'});
  if(v.expected_final.outputContract&&v.input.scenario.driver!=='runtime')ctx.addIssue({code:'custom',message:'output contract requires runtime output'});
  if(v.expected_final.reportContract && (v.input.scenario.driver !== 'runtime' || v.expected_final.outputContract)) ctx.addIssue({ code:'custom', message:'Markdown report requires runtime and cannot also require JSON output' });
  if(realModel!==(v.scope.executionMode==='frozen_tools_live_model'))ctx.addIssue({code:'custom',message:'execution mode must match the actual model driver'});
});
export type EvalCase = z.infer<typeof CaseSchema>;
export const DatasetSchema=z.object({schemaVersion:z.literal('cwatch.eval-dataset.v5'),id,version:z.string().min(1),
  cases:z.array(z.object({id,revision:z.number().int().positive(),file:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1),
}).strict();
export type Outcome='pass'|'fail'|'unknown'|'not_applicable';
export interface CheckResult {criterionId:string;dimension:EvalDimension;outcome:Outcome;method:string;required:boolean;hardFail:boolean;failureCode:string;evidence:Array<{artifact:string;path?:string}>;reason:string}
export interface WorkerObservation {
  runId:string;status:'complete'|'partial'|'failed'|'cancelled';tracePath:string;structuredTracePath?:string;
  facts:Record<string,unknown>;usage:{mode:'fixture'|'live_model';mainTaskTokens:number|null;maintenanceTokens:number|null;physicalModelRequests:number;completeness:'known_fixture'|'not_applicable'|'known'|'partial'};
}
