import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { langfusePayload } from '@cwatch/shared/sessions/langfuse';
import { StructuredTraceSchema } from '@cwatch/shared/sessions/structured-trace';
import { LangfuseClient } from './langfuse-client.ts';
import { HumanSlotSchema, NativeSlotSchema, RejectionSlotSchema, ReviewPending, resolveHumanReview, resolveHumanRejections, resolveNativeReview, type HumanSlot, type NativeSlot } from './langfuse-review.ts';
import { assessmentDirectory, combinedAssessment, finishAssessment, jsonHash, listAssessments, prepareQualitySubject, scoreRules, validateQualityAnswer, type QualitySubject } from './quality.ts';
import { automaticAssessment } from './automatic.ts';
import { sha256, within } from './dataset.ts';
import { saveDetailedEvaluationReport } from './report.ts';
import { archiveEvaluation } from './archive.ts';
import { ensureDimensionJudge, scenarioForCase, scenarioJudgePacket, EvalScenarioSchema, type EvalScenario } from './langfuse-judges.ts';
import { listHumanRejections, saveHumanRejection } from './adjudication.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const ExperimentLinkSchema=z.object({id:z.string().uuid(),name:z.string().min(1),datasetId:z.string().min(1),itemId:z.string().min(1),itemVersion:z.string().optional()}).strict();
export type ExperimentLink=z.infer<typeof ExperimentLinkSchema>;
const BRIDGE_VERSION='cwatch.langfuse-eval.v1-'+sha256(Buffer.concat([readFileSync(fileURLToPath(import.meta.url)),readFileSync(fileURLToPath(new URL('./langfuse-review.ts',import.meta.url)))])).slice(0,16);
const QueueSchema=z.object({id:z.string(),name:z.string(),scoreConfigIds:z.array(z.string())}).passthrough();
const ItemSchema=z.object({id:z.string(),objectId:z.string(),objectType:z.string(),status:z.enum(['PENDING','COMPLETED'])}).passthrough();
const ConfigSchema=z.object({id:z.string(),name:z.string(),dataType:z.string(),isArchived:z.boolean(),description:z.string().nullable().optional(),categories:z.array(z.object({label:z.string(),value:z.number()})).nullable().optional()}).passthrough();
export const LangfuseBindingSchema=z.object({schemaVersion:z.literal('cwatch.langfuse-eval-binding.v1'),report:z.string(),caseId:z.string(),caseRevision:z.number(),attempt:z.number(),runId:z.string(),
  subjectSha256:digest,baseUrl:z.string(),projectId:z.string(),traceId:z.string(),observationId:z.string(),environment:z.string(),createdAt:z.string(),
  traceState:z.enum(['not_started','uncertain','uploaded']),adopted:z.boolean(),native:z.array(NativeSlotSchema),humanSlots:z.array(HumanSlotSchema),queueId:z.string().nullable(),queueItemId:z.string().nullable(),
  scenario:EvalScenarioSchema.nullable().default(null),auditObservationId:z.string().nullable().default(null),experiment:ExperimentLinkSchema.optional(),
  rejectionSlots:z.array(RejectionSlotSchema).default([]),rejectionQueueId:z.string().nullable().default(null),rejectionItemId:z.string().nullable().default(null)}).strict();
export type LangfuseBinding=z.infer<typeof LangfuseBindingSchema>;
const encode=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const attr=(key:string,value:unknown)=>({key,value:{stringValue:typeof value==='string'?value:JSON.stringify(value)}});
const stableId=(value:unknown)=>jsonHash(value);
export const bindingFile=(subject:QualitySubject)=>join(subject.archive.batch,'langfuse',subject.packet.caseId+'-'+subject.packet.attempt+'-'+subject.subjectSha256.slice(0,12),'binding.json');
function saveBinding(path:string,binding:LangfuseBinding):void {writeFileSync(path,encode(LangfuseBindingSchema.parse(binding)));}
async function validateTarget(client:LangfuseClient,binding:LangfuseBinding,subject:QualitySubject):Promise<boolean> {
  const result=z.object({data:z.array(z.object({id:z.string(),traceId:z.string(),metadata:z.record(z.string(),z.unknown()).nullable().optional()}).passthrough())}).parse(
    await client.request('/api/public/v2/observations?'+new URLSearchParams({traceId:binding.traceId,fields:'basic,metadata',expandMetadata:'true',limit:'100'})));
  const observation=result.data.find(row=>row.id===binding.observationId&&row.traceId===binding.traceId);
  if(!observation)return false;
  const raw=observation.metadata?.evalPacket;
  const packet=typeof raw==='string'?JSON.parse(raw):raw;
  if(jsonHash(packet)!==subject.subjectSha256)throw Error('langfuse_target_packet_mismatch');
  return true;
}
function mirrorPayload(subject:QualitySubject,environment:string,scenario:EvalScenario|null,experiment?:ExperimentLink){
  const observed=z.object({structuredTracePath:z.string()}).parse(JSON.parse(readFileSync(join(subject.archive.directory,'observed.json'),'utf8')));
  const file=realpathSync(join(subject.archive.directory,observed.structuredTracePath));
  if(!within(realpathSync(subject.archive.directory),file))throw Error('langfuse_trace_path_escape');
  const document=StructuredTraceSchema.parse(JSON.parse(readFileSync(file,'utf8')));
  const payload=langfusePayload(document,{environment}),originalTraceId=payload.traceId;
  const traceId=stableId(['eval-mirror-v3',subject.subjectSha256,scenario]).slice(0,32);
  const ids=new Map(payload.spans.map(span=>[span.spanId,stableId([subject.subjectSha256,span.spanId]).slice(0,16)]));
  for(const span of payload.spans){span.traceId=traceId;span.spanId=ids.get(span.spanId)!;if(span.parentSpanId)span.parentSpanId=ids.get(span.parentSpanId)!;
    span.attributes.push(attr('langfuse.observation.metadata.evalSubjectSha256',subject.subjectSha256),attr('langfuse.observation.metadata.originalTraceId',originalTraceId),
      attr('langfuse.observation.metadata.mirrorOfRunId',subject.packet.runId),attr('langfuse.observation.metadata.caseId',subject.packet.caseId));}
  const root=payload.spans.find(span=>!span.parentSpanId);if(!root)throw Error('langfuse_root_missing');
  root.attributes.push(attr('langfuse.observation.metadata.evalPacket',subject.packet),attr('langfuse.observation.metadata.evalJudgePacket',scenarioJudgePacket(subject,scenario,'primary')),
    attr('langfuse.observation.metadata.evalBatchSha256',subject.packet.reportSha256),attr('langfuse.observation.metadata.evalJudgeDimensions','|'+subject.packet.llmDimensions.join('|')+'|'),
    attr('langfuse.observation.metadata.evalScenario',scenario),attr('langfuse.observation.metadata.judgeRole','primary'),
    attr('langfuse.observation.metadata.evalPurpose','Evaluation view of one existing real execution; no Agent rerun.'));
  let auditObservationId:string|null=null;
  if(subject.packet.rubric?.criteria.some(c=>c.dimension==='evidence')){
    auditObservationId=stableId([subject.subjectSha256,scenario,'evidence-audit-input-v2']).slice(0,16);
    payload.spans.push({traceId,spanId:auditObservationId,parentSpanId:root.spanId,name:'eval.evidence_audit_input',kind:1,
      startTimeUnixNano:root.endTimeUnixNano,endTimeUnixNano:root.endTimeUnixNano,status:{code:0},attributes:[
        attr('langfuse.observation.type','span'),attr('langfuse.environment',environment),attr('langfuse.trace.name','cwatch.agent'),
        attr('langfuse.observation.metadata.evalJudgePacket',scenarioJudgePacket(subject,scenario,'evidence_audit')),
        attr('langfuse.observation.metadata.evalBatchSha256',subject.packet.reportSha256),attr('langfuse.observation.metadata.evalJudgeDimensions','|evidence|'),
        attr('langfuse.observation.metadata.evalScenario',scenario),attr('langfuse.observation.metadata.judgeRole','evidence_audit'),
        attr('langfuse.observation.metadata.evalPurpose','Host-prepared independent review input. Not another Agent execution or tool call.'),
        attr('langfuse.observation.input',{subjectSha256:subject.subjectSha256,runId:subject.packet.runId,role:'evidence_audit'}),
        attr('langfuse.observation.output',{finalAnswer:subject.packet.finalAnswer})]});
  }
  if(experiment){
    for(const span of payload.spans)span.attributes.push(attr('langfuse.experiment.id',experiment.id),attr('langfuse.experiment.name',experiment.name),
      attr('langfuse.experiment.dataset.id',experiment.datasetId),attr('langfuse.experiment.item.id',experiment.itemId),attr('langfuse.experiment.item.root_observation_id',root.spanId),
      ...(experiment.itemVersion?[attr('langfuse.experiment.item.version',experiment.itemVersion)]:[]));
    root.attributes.push(attr('langfuse.experiment.item.expected_output',subject.archive.value.expected_final),attr('langfuse.experiment.item.metadata.caseId',subject.packet.caseId),
      attr('langfuse.experiment.item.metadata.caseRevision',subject.packet.caseRevision),attr('langfuse.experiment.metadata.reviewMode','separate_human_review'),
      attr('langfuse.experiment.description','真实Agent执行、程序检查与平台LLM Judge。自动分与人工确认分分别保存，未自动确认人工基线。'));
  }
  return{traceId,observationId:root.spanId,auditObservationId,body:{resourceSpans:[{resource:{attributes:[attr('service.name','cwatch')]},scopeSpans:[{scope:{name:'cwatch.eval',version:'2'},spans:payload.spans}]}]}};
}
export async function ensureScoreConfig(client:LangfuseClient,name:string,description:string,categories=['pass','fail','unknown']):Promise<string> {
  const configs=z.array(ConfigSchema).parse(await client.pages('/api/public/score-configs'));
  const same=configs.filter(config=>config.name===name&&!config.isArchived);
  if(same.length>1)throw Error('ambiguous_langfuse_score_config: '+name);
  if(same.length){
    if(same[0].dataType!=='CATEGORICAL'||JSON.stringify(same[0].categories?.map(c=>c.label).sort())!==JSON.stringify([...categories].sort()))throw Error('langfuse_score_config_incompatible: '+name);
    if(same[0].description!==description)await client.request('/api/public/score-configs/'+encodeURIComponent(same[0].id),{description},{},'PATCH');
    return same[0].id;
  }
  return z.object({id:z.string()}).parse(await client.request('/api/public/score-configs',{name,description,dataType:'CATEGORICAL',categories:categories.map((label,index)=>({label,value:1-index}))})).id;
}
export async function ensureQueue(client:LangfuseClient,name:string,description:string,configIds:string[],objectId:string,objectType:'OBSERVATION'|'TRACE'='OBSERVATION'){
  const queues=z.array(QueueSchema).parse(await client.pages('/api/public/annotation-queues'));
  const matches=queues.filter(queue=>queue.name===name);if(matches.length>1)throw Error('ambiguous_langfuse_queue');
  const queue=matches[0]??QueueSchema.parse(await client.request('/api/public/annotation-queues',{name,description,scoreConfigIds:configIds}));
  if(JSON.stringify([...queue.scoreConfigIds].sort())!==JSON.stringify([...configIds].sort()))throw Error('langfuse_queue_config_mismatch');
  const items=z.array(ItemSchema).parse(await client.pages('/api/public/annotation-queues/'+encodeURIComponent(queue.id)+'/items'));
  const same=items.filter(item=>item.objectId===objectId&&item.objectType===objectType);if(same.length>1)throw Error('ambiguous_langfuse_queue_item');
  const item=same[0]??ItemSchema.parse(await client.request('/api/public/annotation-queues/'+encodeURIComponent(queue.id)+'/items',{objectId,objectType}));
  return{queueId:queue.id,itemId:item.id};
}
async function humanQueue(client:LangfuseClient,binding:LangfuseBinding,subject:QualitySubject):Promise<void> {
  if(!subject.humanApplicable)return;
  const suffix='r'+subject.packet.caseRevision+' '+subject.subjectSha256.slice(0,8),slots:HumanSlot[]=[];
  for(const criterion of subject.packet.requirements.trajectory.criteria){
    const name='人工过程 '+criterion.id+' '+suffix;
    const description=criterion.expectation+'\n填写 pass/fail/unknown。Comment 写具体理由，并引用本次执行证据，例如 [task] [rules] [final-answer] [trace:7]。不填写扣分数。';
    slots.push({kind:'process',criterionId:criterion.id,name,configId:await ensureScoreConfig(client,name,description)});
  }
  if(subject.packet.humanReview.dimensions.includes('safety'))for(const requirement of subject.packet.requirements.safety.requirements){
    const name='人工安全 '+subject.packet.caseId+'-'+requirement.id+' '+suffix;
    slots.push({kind:'safety',requirementId:requirement.id,name,configId:await ensureScoreConfig(client,name,requirement.assertion+'\nComment 写理由和证据，如 [task] [trace:7]。没有足够执行记录时选 unknown。')});
  }
  const queued=await ensureQueue(client,'cwatch · '+subject.packet.caseId+' r'+subject.packet.caseRevision+' · Trial '+subject.packet.attempt+' · '+subject.subjectSha256.slice(0,8),
    '这是该修订真实执行的人工评审，不是新版 Case 1 基线确认。请查阅输入、完整 Trace 和输出，逐项标注并填写证据引用，再点 Complete。程序按原扣分制汇总，不会替你填写判定。subjectSha256='+subject.subjectSha256,slots.map(slot=>slot.configId),binding.observationId);
  binding.humanSlots=slots;binding.queueId=queued.queueId;binding.queueItemId=queued.itemId;
}
async function prepareNativeEvaluators(client:LangfuseClient,binding:LangfuseBinding,subject:QualitySubject):Promise<void> {
  if(!subject.llmApplicable||binding.native.length)return; // Existing version pins remain immutable.
  if(!binding.scenario)throw Error('evaluation_scenario_required');
  if(JSON.stringify(subject.packet).length>120000)throw Error('native_judge_packet_too_large');
  for(const dimension of subject.packet.llmDimensions){
    const evaluator=await ensureDimensionJudge(client,dimension);
    const shared={evaluatorId:evaluator.id,versionId:evaluator.versionId,name:evaluator.name,contract:'dimension' as const,scenario:binding.scenario,dimension};
    binding.native.push({...shared,role:'primary',observationId:binding.observationId});
    if(dimension==='evidence'){
      if(!binding.auditObservationId)throw Error('independent_audit_observation_missing');
      binding.native.push({...shared,role:'evidence_audit',observationId:binding.auditObservationId});
    }
  }
}
/** Prepare code scores and optional human work without invoking the Agent or a Judge. */
export async function prepareLangfuseEvaluation(client:LangfuseClient,options:{report:string;caseId:string;attempt?:number;queueHuman?:boolean;adjudication?:boolean;native?:boolean;scenario?:EvalScenario;experiment?:ExperimentLink;adopt?:{traceId:string;observationId:string;native:NativeSlot[]}}){
  const subject=prepareQualitySubject(options.report,options.caseId,options.attempt??1,client.redactor),path=bindingFile(subject);
  mkdirSync(dirname(path),{recursive:true});if(!within(realpathSync(subject.archive.batch),realpathSync(dirname(path))))throw Error('langfuse_binding_path_escape');
  const projectId=await client.projectId();
  const scenario=scenarioForCase(options.caseId,options.scenario)??null;
  if(options.native&&subject.llmApplicable&&!scenario)throw Error('evaluation_scenario_required: use --scenario activation|core_logic|resilience|artifact_quality');
  const experiment=options.experiment?ExperimentLinkSchema.parse(options.experiment):undefined;
  const mirror=mirrorPayload(subject,client.config.environment,scenario,experiment);
  const binding=existsSync(path)?LangfuseBindingSchema.parse(JSON.parse(readFileSync(path,'utf8'))):LangfuseBindingSchema.parse({
    schemaVersion:'cwatch.langfuse-eval-binding.v1',report:resolve(options.report),caseId:options.caseId,caseRevision:subject.packet.caseRevision,attempt:subject.packet.attempt,runId:subject.packet.runId,
    subjectSha256:subject.subjectSha256,baseUrl:client.config.baseUrl,projectId,traceId:options.adopt?.traceId??mirror.traceId,observationId:options.adopt?.observationId??mirror.observationId,
    environment:client.config.environment,createdAt:new Date().toISOString(),traceState:options.adopt?'uploaded':'not_started',adopted:Boolean(options.adopt),native:options.adopt?.native??[],humanSlots:[],queueId:null,queueItemId:null,
    scenario,auditObservationId:options.adopt?null:mirror.auditObservationId,...(experiment?{experiment}:{})});
  if(experiment&&JSON.stringify(binding.experiment)!==JSON.stringify(experiment))throw Error('binding_experiment_mismatch');
  if(options.scenario&&binding.scenario!==options.scenario)throw Error('binding_scenario_mismatch: frozen scoring input cannot be retagged after upload');
  if(binding.subjectSha256!==subject.subjectSha256||binding.projectId!==projectId||binding.baseUrl!==client.config.baseUrl)throw Error('langfuse_binding_scope_mismatch');
  if(options.adopt&&(binding.traceId!==options.adopt.traceId||binding.observationId!==options.adopt.observationId||JSON.stringify(binding.native)!==JSON.stringify(options.adopt.native)))throw Error('langfuse_adoption_mismatch');
  saveBinding(path,binding);
  if(binding.traceState==='not_started'){
    binding.traceState='uncertain';saveBinding(path,binding);
    const result=z.object({partialSuccess:z.object({rejectedSpans:z.union([z.number(),z.string()]).optional(),errorMessage:z.string().optional()}).optional()}).passthrough().parse(
      await client.request('/api/public/otel/v1/traces',mirror.body,{'x-langfuse-ingestion-version':'4'}));
    if(result.partialSuccess?.errorMessage||Number(result.partialSuccess?.rejectedSpans??0)>0)throw Error('langfuse_otlp_partial_failure');
    binding.traceState='uploaded';saveBinding(path,binding);
  }else if(!await validateTarget(client,binding,subject))throw new ReviewPending('Langfuse 尚未显示已上传的目标；不会重发可能已经接收的 v4 Span，请稍后重试。');
  if(binding.traceState==='uncertain'){binding.traceState='uploaded';saveBinding(path,binding);}
  if(!listAssessments(subject).some(record=>record.kind==='rules'&&record.status==='completed'))scoreRules(subject);
  const scores=subject.packet.rules.checks.map(check=>({id:stableId([subject.subjectSha256,'code',check.criterionId]),name:'code.'+check.criterionId,value:check.outcome,dataType:'CATEGORICAL',
    traceId:binding.traceId,observationId:binding.observationId,environment:binding.environment,comment:JSON.stringify({reason:check.reason,evidence:check.evidence}),
    metadata:{method:'code',subjectSha256:subject.subjectSha256,dimension:check.dimension,required:check.required,hardFail:check.hardFail}}));
  await client.writeScores(scores);
  if(options.native)await prepareNativeEvaluators(client,binding,subject);
  if(options.queueHuman!==false)await humanQueue(client,binding,subject);
  if(options.adjudication){
    const slots=[];
    for(const criterion of subject.packet.rubric?.criteria.filter(c=>['outcome','evidence'].includes(c.dimension))??[]){
      const name='人工否决复核 '+criterion.id+' r'+binding.caseRevision+' '+subject.subjectSha256.slice(0,8);
      slots.push({criterionId:criterion.id,name,configId:await ensureScoreConfig(client,name,'可选的明确否决入口。not_reviewed=未审核；no_rejection=本次不提出否决，不替代模型判定；reject=明确否决该冻结条目。reject 必须在 Comment 写用户自己的理由及全部必要证据引用。旧否决不会被此处的新标签自动撤销。',['not_reviewed','no_rejection','reject'])});
    }
    if(slots.length){const queued=await ensureQueue(client,'cwatch · '+binding.caseId+' r'+binding.caseRevision+' · 可选否决复核 · '+subject.subjectSha256.slice(0,8),
      '这是可选的结果/证据人工否决，独立于流程/安全评审。只在实际检查后填写；程序保留模型原结论并按原规则合并一次 P0 扣分。',slots.map(slot=>slot.configId),binding.observationId);
      binding.rejectionSlots=slots;binding.rejectionQueueId=queued.queueId;binding.rejectionItemId=queued.itemId;}
  }
  saveBinding(path,binding);
  writeFileSync(join(dirname(path),'review-guide.json'),encode({caseId:subject.packet.caseId,revision:subject.packet.caseRevision,runId:subject.packet.runId,
    requirements:subject.packet.requirements,humanSlots:binding.humanSlots,allowedEvidenceRefs:subject.packet.allowedEvidenceRefs,trace:subject.packet.evidence}));
  return{path,binding,traceUrl:binding.baseUrl+'/project/'+binding.projectId+'/traces/'+binding.traceId,queueUrl:binding.queueId?binding.baseUrl+'/project/'+binding.projectId+'/annotation-queues/'+binding.queueId:null,
    rejectionQueueUrl:binding.rejectionQueueId?binding.baseUrl+'/project/'+binding.projectId+'/annotation-queues/'+binding.rejectionQueueId:null};
}
function recordPlatformReview(subject:QualitySubject,kind:'llm'|'human',answer:Parameters<typeof finishAssessment>[2]['answer'],scores:unknown[],metadata:Record<string,unknown>,reviewer:string|null){
  const inputSha256=jsonHash(scores),previous=listAssessments(subject).filter(record=>record.kind===kind).at(-1);
  if(previous?.status==='completed'&&previous.metadata.platformInputSha256===inputSha256&&previous.metadata.graderVersion===metadata.graderVersion)return previous;
  const target=assessmentDirectory(subject);writeFileSync(join(target.directory,'platform-scores.json'),encode(scores));
  return finishAssessment(subject,target,{kind,status:'completed',answer,reviewer,error:null,metadata:{...metadata,backend:'langfuse',platformInputSha256:inputSha256}}).record;
}
/** JSON transport omits undefined optional fields; compare the exact serialized frozen input. */
export function hostReviewPacketMatches(subject:QualitySubject,scenario:EvalScenario|null,packet:unknown):boolean {
  if(!packet||typeof packet!=='object'||Array.isArray(packet))return false;
  const {evaluationOutputContract,...original}=packet as Record<string,unknown>;void evaluationOutputContract;
  return isDeepStrictEqual(original,JSON.parse(JSON.stringify(scenarioJudgePacket(subject,scenario,'primary'))));
}
/** Pull existing platform decisions; no Agent run, model request or synthetic human approval. */
export async function syncLangfuseEvaluation(client:LangfuseClient,bindingPath:string,options:{archive?:boolean}={}){
  const path=realpathSync(bindingPath),binding=LangfuseBindingSchema.parse(JSON.parse(readFileSync(path,'utf8')));
  const subject=prepareQualitySubject(binding.report,binding.caseId,binding.attempt,client.redactor);
  if(!within(realpathSync(subject.archive.batch),path)||binding.subjectSha256!==subject.subjectSha256||binding.caseRevision!==subject.packet.caseRevision||binding.runId!==subject.packet.runId||binding.baseUrl!==client.config.baseUrl||binding.projectId!==await client.projectId())throw Error('langfuse_binding_scope_mismatch');
  if(!await validateTarget(client,binding,subject))throw new ReviewPending('等待目标 Trace 可见');
  for(const slot of binding.native.filter(slot=>slot.reviewInput)){
    const observations=z.object({data:z.array(z.object({id:z.string(),traceId:z.string(),name:z.string().nullable().optional(),parentObservationId:z.string().nullable().optional(),metadata:z.record(z.string(),z.unknown()).nullable().optional()}).passthrough())}).parse(
      await client.request('/api/public/v2/observations?'+new URLSearchParams({traceId:binding.traceId,fields:'basic,metadata',expandMetadata:'true',limit:'100'})));
    const observation=observations.data.find(row=>row.id===slot.observationId);
    if(!observation)throw new ReviewPending('等待补充过程评审输入可见');
    const raw=observation.metadata?.evalJudgePacket,packet=typeof raw==='string'?JSON.parse(raw):raw;
    if(!packet||typeof packet!=='object')throw Error('host_review_retry_packet_missing');
    if(observation.traceId!==binding.traceId||observation.parentObservationId!==binding.observationId||observation.name!=='eval.trajectory_review_input'||
      slot.reviewInput!.rootObservationId!==binding.observationId||slot.reviewInput!.subjectSha256!==subject.subjectSha256||
      jsonHash(packet)!==slot.reviewInput!.packetSha256||!hostReviewPacketMatches(subject,binding.scenario,packet))throw Error('host_review_retry_provenance_mismatch');
  }
  const rows=await client.scores(binding.traceId),pending:string[]=[];
  if(binding.native.length){
    try{
      const reviewed=resolveNativeReview(subject,binding,binding.native,rows);
      recordPlatformReview(subject,'llm',reviewed.answer,reviewed.scores,{graderVersion:BRIDGE_VERSION+'-native',rubricSha256:subject.packet.rubricSha256,evaluatorVersions:binding.native,physicalRequests:null,totalTokens:null},null);
    }catch(error){
      if(error instanceof ReviewPending)pending.push(error.message);
      else{
        const message=client.redactor.clean(error instanceof Error?error.message:'invalid_native_review');
        const names=new Set(binding.native.map(slot=>slot.name));
        const nativeRows=rows.filter(row=>row&&typeof row==='object'&&'source' in row&&row.source==='EVAL'&&'name' in row&&typeof row.name==='string'&&names.has(row.name));
        const platformInputSha256=jsonHash({nativeRows,versions:binding.native}),previous=listAssessments(subject).filter(record=>record.kind==='llm').at(-1);
        if(previous?.status!=='invalid'||previous.metadata.platformInputSha256!==platformInputSha256||previous.metadata.graderVersion!==BRIDGE_VERSION+'-native'){
          const target=assessmentDirectory(subject);writeFileSync(join(target.directory,'platform-scores.json'),encode(client.redactor.clean(nativeRows)));
          finishAssessment(subject,target,{kind:'llm',status:'invalid',answer:null,reviewer:null,error:message,metadata:{backend:'langfuse',graderVersion:BRIDGE_VERSION+'-native',evaluatorVersions:binding.native,platformInputSha256,physicalRequests:null,totalTokens:null}});
        }
        pending.push('平台评委结果无效：'+message);
      }
    }
  }
  if(binding.queueId&&binding.queueItemId){
    const item=ItemSchema.parse(await client.request('/api/public/annotation-queues/'+encodeURIComponent(binding.queueId)+'/items/'+encodeURIComponent(binding.queueItemId)));
    if(item.objectId!==binding.observationId||item.objectType!=='OBSERVATION')throw Error('langfuse_queue_target_mismatch');
    try{
      const reviewed=resolveHumanReview(subject,binding,{id:binding.queueId,completed:item.status==='COMPLETED'},binding.humanSlots,rows);
      const answer=validateQualityAnswer(reviewed.input.answer,subject,'human');
      recordPlatformReview(subject,'human',client.redactor.clean(answer),reviewed.scores,{graderVersion:BRIDGE_VERSION+'-human',identity:'langfuse_annotation_author',queueId:binding.queueId,queueItemId:binding.queueItemId},reviewed.input.reviewer);
    }catch(error){pending.push(error instanceof ReviewPending?error.message:'人工标注格式无效；请核对分类、理由和证据引用。');}
  }
  if(binding.rejectionQueueId&&binding.rejectionItemId){
    const item=ItemSchema.parse(await client.request('/api/public/annotation-queues/'+encodeURIComponent(binding.rejectionQueueId)+'/items/'+encodeURIComponent(binding.rejectionItemId)));
    if(item.objectId!==binding.observationId||item.objectType!=='OBSERVATION')throw Error('langfuse_rejection_target_mismatch');
    try{
      for(const rejected of resolveHumanRejections(subject,binding,{id:binding.rejectionQueueId,completed:item.status==='COMPLETED'},binding.rejectionSlots,rows)){
        const input={...rejected.input,notes:JSON.stringify({source:'Langfuse ANNOTATION',queueId:binding.rejectionQueueId,scoreId:rejected.score.id,updatedAt:rejected.score.updatedAt,platformScoreSha256:jsonHash(rejected.score)})};
        if(!listHumanRejections(subject).some(record=>record.inputSha256===jsonHash(input))){
          const snapshot=join(dirname(path),'human-rejection-platform-'+jsonHash(rejected.score)+'.json');if(!existsSync(snapshot))writeFileSync(snapshot,encode(client.redactor.clean(rejected.score)));
          saveHumanRejection(subject,client.redactor.clean(input));
        }
      }
    }catch(error){pending.push(error instanceof ReviewPending?error.message:'人工否决格式无效，需要审核者修正理由和证据。');}
  }
  const records=listAssessments(subject),llm=records.filter(record=>record.kind==='llm').at(-1),human=records.filter(record=>record.kind==='human').at(-1);
  const effectiveLlm=binding.native.length&&jsonHash(llm?.metadata.evaluatorVersions??null)!==jsonHash(binding.native)?null:llm??null;
  const automatic=automaticAssessment(subject.archive.value,subject.packet.rules.checks,subject.packet.rules.durationMs,effectiveLlm,human??null);
  const final=combinedAssessment(subject,records);
  if(subject.llmApplicable&&!llm)pending.push('等待本例分配的 LLM 评审');
  if(subject.humanApplicable&&!human)pending.push('等待本例分配的人工评审');
  const ready=pending.length===0;
  const aggregate={schemaVersion:'cwatch.langfuse-eval-sync.v1',subjectSha256:subject.subjectSha256,runId:binding.runId,caseId:binding.caseId,caseRevision:binding.caseRevision,
    syncedAt:new Date().toISOString(),status:ready?(final.penalty.complete?'completed':'needs_review'):'awaiting_review',pending,
    automatic,final:{...final.penalty,score:ready?final.penalty.score:null,complete:ready&&final.penalty.complete,passed:ready&&final.penalty.passed},
    queueUrl:binding.queueId?binding.baseUrl+'/project/'+binding.projectId+'/annotation-queues/'+binding.queueId:null};
  const version=stableId({bridgeVersion:BRIDGE_VERSION,automatic,final:aggregate.final,pending,records:records.map(record=>record.id)});
  const priorPath=join(dirname(path),'latest-sync.json');
  const previous=existsSync(priorPath)?z.object({version:z.string()}).passthrough().parse(JSON.parse(readFileSync(priorPath,'utf8'))):null;
  const score=(name:string,value:number|string,dataType:'NUMERIC'|'BOOLEAN'|'CATEGORICAL',comment:string)=>({id:stableId([subject.subjectSha256,version,name]),name,value,dataType,
    traceId:binding.traceId,observationId:binding.observationId,environment:binding.environment,comment,metadata:{subjectSha256:subject.subjectSha256,aggregationVersion:version,penaltyVersion:'cwatch.penalty.v5'}});
  if(previous?.version!==version){
    const output=[score('automatic.status',automatic.verdict,'CATEGORICAL','自动分不包含人工确认。'),score('automatic.score_available',automatic.score===null?0:1,'BOOLEAN','与相同 aggregationVersion 的自动分一起读取。'),score('final.status',aggregate.status,'CATEGORICAL',pending.join('; ')||'原扣分程序汇总。'),
      score('final.score_available',aggregate.final.score===null?0:1,'BOOLEAN','只有本次 final.status 完整且 score_available=true 时才读取对应版本的总分；旧分数保留为历史。')];
    if(automatic.score!==null){output.push(score('automatic.total',automatic.score,'NUMERIC','按原规则计算的自动分。'));
      for(const [name,value]of [['process',automatic.processDeduction],['time',automatic.efficiencyDeduction],['veto',automatic.resultDeduction]] as const)if(value!==null)output.push(score('automatic.deduction.'+name,value,'NUMERIC','原规则扣分明细；不是独立加分项。'));}
    if(aggregate.final.score!==null){output.push(score('final.total',aggregate.final.score,'NUMERIC','按原规则汇总，保留人工与模型原始判定。'));
      for(const deduction of final.penalty.deductions)output.push(score('final.deduction.'+deduction.group,deduction.points,'NUMERIC',JSON.stringify(deduction)));}
    // Preserve local Judge findings even when the evaluator ran outside the platform.
    if(!binding.native.length&&llm?.answer)for(const finding of llm.answer.findings)output.push(score('llm.'+finding.criterionId,finding.verdict,'CATEGORICAL',JSON.stringify(finding)));
    await client.writeScores(output);
    const automaticReport=saveDetailedEvaluationReport(binding.report,{evaluationMode:'automatic'});
    const finalReport=ready?saveDetailedEvaluationReport(binding.report,{evaluationMode:'human_review'}):null;
    const archive=options.archive!==false&&ready?archiveEvaluation(subject.archive.batch,[client.config.publicKey,client.config.secretKey]).path:null;
    writeFileSync(priorPath,encode({...aggregate,version,reports:{automatic:automaticReport,final:finalReport},archive}));
  }
  return{...aggregate,binding:path,version};
}
