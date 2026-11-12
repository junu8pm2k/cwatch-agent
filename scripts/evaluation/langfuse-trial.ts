import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { langfusePayload } from '@cwatch/shared/sessions/langfuse';
import { StructuredTraceSchema } from '@cwatch/shared/sessions/structured-trace';
import { LangfuseClient } from './langfuse-client.ts';
import { ensureQueue, ensureScoreConfig } from './langfuse-eval.ts';
import { jsonHash } from './quality.ts';
import { InputSchema, type WorkerObservation } from './contracts.ts';
import { PlatformScoreSchema, parseReviewComment, onTarget, ReviewPending } from './langfuse-review.ts';
import { inventory, verifyInventory } from './grader.ts';
import { within } from './dataset.ts';

export const BaselineTrialSchema=z.object({schemaVersion:z.literal('cwatch.prompt-only-trial.v1'),id:z.string(),caseId:z.string(),caseRevision:z.number().int().positive(),createdAt:z.string(),
  inputSha256:z.string(),reviewStatus:z.literal('awaiting_user_review'),baselineConfirmed:z.literal(false),expectations:z.null(),rubric:z.null(),judge:z.null()}).strict();
const TrialBindingSchema=z.object({schemaVersion:z.literal('cwatch.langfuse-baseline-binding.v1'),trialSha256:z.string(),projectId:z.string(),baseUrl:z.string(),traceId:z.string(),observationId:z.string(),
  traceState:z.enum(['not_started','uncertain','uploaded']),slots:z.array(z.object({kind:z.enum(['process','outcome']),name:z.string(),configId:z.string()})),queueId:z.string().nullable(),itemId:z.string().nullable()}).strict();
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
const attr=(key:string,value:unknown)=>({key,value:{stringValue:typeof value==='string'?value:JSON.stringify(value)}});
function readTrial(trialFile:string){
  const file=realpathSync(trialFile),root=dirname(file),trial=BaselineTrialSchema.parse(JSON.parse(readFileSync(file,'utf8'))),input=InputSchema.parse(JSON.parse(readFileSync(join(root,'input.json'),'utf8')));
  const manifest=z.object({evidence:z.array(z.object({path:z.string(),sha256:z.string(),bytes:z.number()}))}).parse(JSON.parse(readFileSync(join(root,'evidence-manifest.json'),'utf8')));
  if(!['trial.json','input.json','observed.json','outcome.md'].every(path=>manifest.evidence.some(item=>item.path===path))||verifyInventory(root,manifest.evidence).length||jsonHash(input)!==trial.inputSha256)throw Error('baseline_trial_integrity_failure');
  const observed=z.object({runId:z.string(),tracePath:z.string(),structuredTracePath:z.string()}).passthrough().parse(JSON.parse(readFileSync(join(root,'observed.json'),'utf8')));
  const tracePath=realpathSync(join(root,observed.structuredTracePath));if(!within(root,tracePath)||!manifest.evidence.some(item=>item.path===observed.structuredTracePath.replaceAll('\\','/')))throw Error('baseline_trace_not_in_manifest');
  const trace=StructuredTraceSchema.parse(JSON.parse(readFileSync(tracePath,'utf8')));
  if(trace.runId!==observed.runId)throw Error('baseline_trial_run_mismatch');
  const eventsFile=realpathSync(join(root,observed.tracePath));if(!within(root,eventsFile)||!manifest.evidence.some(item=>item.path===observed.tracePath.replaceAll('\\','/')))throw Error('baseline_events_not_in_manifest');
  const events=readFileSync(eventsFile,'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>z.object({sequence:z.number().int(),type:z.string()}).passthrough().parse(JSON.parse(line)));
  const refs=new Set(['task','final-answer',...trace.steps.map(step=>'step:'+step.stepId),...events.map(event=>'trace:'+event.sequence)]);
  return{root,trial,input,observed,trace,refs,traceReferences:events.map(event=>({ref:'trace:'+event.sequence,type:event.type})),trialSha256:jsonHash({trial,input,manifest})};
}
/** Publish an immutable real prompt-only execution; never creates a Judge, score or confirmed baseline. */
export async function publishBaselineTrial(client:LangfuseClient,trialFile:string){
  const trial=readTrial(trialFile),path=join(trial.root,'langfuse-baseline.json'),projectId=await client.projectId();
  const payload=langfusePayload(trial.trace,{environment:'baseline-trial'}),traceId=jsonHash(['baseline-trial',trial.trialSha256]).slice(0,32);
  const ids=new Map(payload.spans.map(span=>[span.spanId,jsonHash([trial.trialSha256,span.spanId]).slice(0,16)]));
  for(const span of payload.spans){span.traceId=traceId;span.spanId=ids.get(span.spanId)!;if(span.parentSpanId)span.parentSpanId=ids.get(span.parentSpanId)!;
    span.attributes.push(attr('langfuse.observation.metadata.caseId',trial.trial.caseId),attr('langfuse.observation.metadata.caseRevision',trial.trial.caseRevision),
      attr('langfuse.observation.metadata.baselineTrialSha256',trial.trialSha256),attr('langfuse.observation.metadata.mirrorOfRunId',trial.trace.runId));}
  const root=payload.spans.find(span=>!span.parentSpanId);if(!root)throw Error('baseline_trial_root_missing');
  root.attributes.push(attr('langfuse.observation.metadata.baselineReview',{purpose:'Prompt-only trial; human acceptance only; no evaluation score or confirmed baseline.',
    caseId:trial.trial.caseId,caseRevision:trial.trial.caseRevision,runId:trial.trace.runId,input:trial.input,allowedEvidenceRefs:[...trial.refs],baselineConfirmed:false}));
  const binding=existsSync(path)?TrialBindingSchema.parse(JSON.parse(readFileSync(path,'utf8'))):TrialBindingSchema.parse({schemaVersion:'cwatch.langfuse-baseline-binding.v1',trialSha256:trial.trialSha256,
    projectId,baseUrl:client.config.baseUrl,traceId,observationId:root.spanId,traceState:'not_started',slots:[],queueId:null,itemId:null});
  if(binding.trialSha256!==trial.trialSha256||binding.projectId!==projectId||binding.baseUrl!==client.config.baseUrl||binding.traceId!==traceId||binding.observationId!==root.spanId)throw Error('baseline_platform_binding_mismatch');
  save(path,binding);
  if(binding.traceState==='uncertain')throw new ReviewPending('上次基线 Trace 上报结果不确定，请先核对平台；不会自动重发。');
  if(binding.traceState==='not_started'){
    binding.traceState='uncertain';save(path,binding);
    const result=z.object({partialSuccess:z.object({rejectedSpans:z.union([z.number(),z.string()]).optional(),errorMessage:z.string().optional()}).optional()}).passthrough().parse(await client.request('/api/public/otel/v1/traces',
      {resourceSpans:[{resource:{attributes:[attr('service.name','cwatch')]},scopeSpans:[{scope:{name:'cwatch.baseline-trial',version:'1'},spans:payload.spans}]}]},{'x-langfuse-ingestion-version':'4'}));
    if(result.partialSuccess?.errorMessage||Number(result.partialSuccess?.rejectedSpans??0)>0)throw Error('baseline_otlp_partial_failure');
    binding.traceState='uploaded';save(path,binding);
  }
  const suffix=trial.trial.caseId+' r'+trial.trial.caseRevision+' '+trial.trialSha256.slice(0,8);
  const processReference=trial.traceReferences.find(event=>event.type==='pre_tool_use_request')??trial.traceReferences[0];
  const processExample=processReference?'['+processReference.ref+']（本次实际'+(processReference.type==='pre_tool_use_request'?'工具请求':'执行事件')+'）':'[step:实际步骤ID]';
  for(const kind of ['process','outcome'] as const){
    const name=(kind==='process'?'基线流程认可 ':'基线产物认可 ')+suffix;
    const description=(kind==='process'?'你是否认可本次真实执行的流程和权限边界？':'你是否认可本次原始交付，作为该 Prompt 的基线候选？')+
      '\naccept=认可本次执行，reject=不认可，unknown=暂无法判断。选择分类后在 Comment 写你自己的理由。流程证据可引用原始 Trace 的 '+processExample+'，也可引用 [step:实际步骤ID]；产物证据请写 [final-answer]。这不是自动分，不替代后续评分标准。';
    const configId=await ensureScoreConfig(client,name,description,['accept','reject','unknown']);
    const existing=binding.slots.find(slot=>slot.kind===kind);if(existing){if(existing.configId!==configId)throw Error('baseline_score_config_changed');}else binding.slots.push({kind,name,configId});save(path,binding);
  }
  const queued=await ensureQueue(client,'新版 Case 1 r'+trial.trial.caseRevision+' · 纯执行基线 · '+trial.trialSha256.slice(0,8),
    '只审核这次真实 Prompt/Trace/Outcome。没有加载评分预期，没有运行 Judge，也没有继承旧版分数。请填写两项认可意见及 Comment 后 Complete。认可记录将被拉回本地；基线登记单独保留身份与证据，不用本次认可冒充五次稳定性或量表批准。',binding.slots.map(slot=>slot.configId),binding.observationId);
  binding.queueId=queued.queueId;binding.itemId=queued.itemId;save(path,binding);
  const result={binding:path,trial:trialFile,runId:trial.trace.runId,traceUrl:binding.baseUrl+'/project/'+projectId+'/traces/'+traceId,
    queueUrl:binding.baseUrl+'/project/'+projectId+'/annotation-queues/'+binding.queueId,allowedEvidenceRefs:[...trial.refs],traceReferences:trial.traceReferences,baselineConfirmed:false};
  save(join(trial.root,'langfuse-review-guide.json'),result);return result;
}
/** Reading the user's actual annotation never fabricates acceptance or registers an unapproved Case. */
export async function syncBaselineTrial(client:LangfuseClient,trialFile:string){
  const trial=readTrial(trialFile),binding=TrialBindingSchema.parse(JSON.parse(readFileSync(join(trial.root,'langfuse-baseline.json'),'utf8')));
  if(binding.trialSha256!==trial.trialSha256||binding.baseUrl!==client.config.baseUrl||binding.projectId!==await client.projectId())throw Error('baseline_platform_binding_mismatch');
  if(!binding.queueId||!binding.itemId)throw new ReviewPending('基线标注队列尚未准备好');
  const item=z.object({objectId:z.string(),objectType:z.string(),status:z.string()}).parse(await client.request('/api/public/annotation-queues/'+encodeURIComponent(binding.queueId)+'/items/'+encodeURIComponent(binding.itemId)));
  if(item.objectId!==binding.observationId||item.objectType!=='OBSERVATION')throw Error('baseline_queue_target_mismatch');
  if(item.status!=='COMPLETED')return{status:'awaiting_human',baselineConfirmed:false};
  const scores=(await client.scores(binding.traceId)).map(row=>PlatformScoreSchema.parse(row));
  const selected=binding.slots.map(slot=>{
    const matching=scores.filter(score=>onTarget(score,binding)&&score.source==='ANNOTATION'&&score.queueId===binding.queueId&&score.configId===slot.configId&&score.name===slot.name);
    if(new Set(matching.map(score=>score.authorUserId)).size!==1)throw new ReviewPending('基线意见缺失或有多位审核者，需要人工裁定');
    const score=matching.sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.id.localeCompare(b.id)).at(-1);
    if(!score?.authorUserId)throw new ReviewPending('基线意见必须由真实审核者填写');
    const finding={verdict:z.enum(['accept','reject','unknown']).parse(score.value),...parseReviewComment(score.comment,trial.refs)};
    if(slot.kind==='process'&&!finding.evidence.some(ref=>ref.startsWith('step:')||ref.startsWith('trace:')))throw new ReviewPending('流程认可需要引用一条真实 [step:步骤ID] 或 [trace:序号]');
    if(slot.kind==='outcome'&&!finding.evidence.includes('final-answer'))throw new ReviewPending('产物认可需要引用 [final-answer]');
    return{kind:slot.kind,finding,score};
  });
  if(selected.length!==2||new Set(selected.map(row=>row.kind)).size!==2||new Set(selected.map(row=>row.score.authorUserId)).size!==1)throw new ReviewPending('基线流程与产物需由同一审核者完整填写');
  const status=selected.some(row=>row.finding.verdict==='reject')?'rejected':selected.every(row=>row.finding.verdict==='accept')?'human_accepted':'needs_review';
  const review={schemaVersion:'cwatch.langfuse-baseline-feedback.v1',trialSha256:trial.trialSha256,caseId:trial.trial.caseId,caseRevision:trial.trial.caseRevision,runId:trial.trace.runId,
    reviewerUserId:selected[0].score.authorUserId,status,baselineConfirmed:false,baselineRegistration:'not_registered',platformScores:selected};
  const path=join(trial.root,'human-feedback-'+jsonHash(review).slice(0,16)+'.json');if(!existsSync(path))save(path,review);
  return{status,review:path,baselineConfirmed:false};
}
export function sealPromptOnlyTrial(directory:string,observed:WorkerObservation):void {
  writeFileSync(join(directory,'observed.json'),JSON.stringify(observed,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(directory,'outcome.md'),String(observed.facts.response??''),{flag:'wx'});
  writeFileSync(join(directory,'evidence-manifest.json'),JSON.stringify({evidence:inventory(directory)},null,2)+'\n',{flag:'wx'});
}
