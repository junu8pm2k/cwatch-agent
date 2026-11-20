import { z } from 'zod';
import { reportedTokens } from '../agent/core/budgets.ts';
import type { TraceEvent } from './trace.ts';

export const STRUCTURED_TRACE_VERSION = 'cwatch.structured-trace.v1' as const;
const text = z.string().min(1), nullableText = text.nullable(), count = z.number().int().nonnegative();
const attrs = z.record(z.string(), z.json());
const status = z.enum(['pending','running','completed','partial','blocked','failed','cancelled','unknown']);
export const TraceErrorSchema = z.object({ code:text, message:text, category:z.enum(['model','tool','source','permission','budget','runtime']), retryable:z.boolean().nullable() }).strict();
export const TraceStepSchema = z.object({
  stepId:text,parentStepId:nullableText,kind:z.enum(['run','model','tool','backend','process']),name:text,status,
  timing:z.object({requestedAt:nullableText,startedAt:nullableText,endedAt:nullableText,durationMs:count.nullable(),executionDurationMs:count.nullable()}).strict(),
  correlation:z.object({iteration:count.nullable(),requestId:nullableText,sdkToolCallId:nullableText,bindingId:nullableText,stageId:nullableText,sessionId:nullableText}).strict(),
  input:z.json().nullable(),output:z.json().nullable(),error:TraceErrorSchema.nullable(),resultStatus:nullableText,
  attributes:attrs,usage:z.array(attrs),eventIds:z.array(text),
}).strict();
export const StructuredTraceSchema = z.object({
  schemaVersion:z.literal(STRUCTURED_TRACE_VERSION),traceId:text,taskId:text,runId:text,
  status:z.enum(['complete','partial','failed','cancelled','incomplete']),
  input:z.object({task:z.json().nullable(),mode:nullableText,permissionMode:nullableText,engine:nullableText,model:z.json().nullable()}).strict(),
  output:z.object({response:z.string().nullable(),report:nullableText,gaps:z.array(z.string())}).strict(),
  timing:z.object({startedAt:nullableText,endedAt:nullableText,durationMs:count.nullable()}).strict(),
  summary:z.object({modelRounds:count,auxiliaryUsageRecords:count,toolRequests:count,toolExecutions:count,backendExecutions:count,
    knownTokens:count,totalTokens:count.nullable(),unknownUsageRecords:count,physicalModelRequests:count.nullable(),actualCost:z.number().nonnegative().nullable()}).strict(),
  source:z.object({format:z.literal('trace-events-jsonl'),path:nullableText,sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),schemaVersions:z.array(z.number().int().positive()),eventCount:count}).strict(),
  integrity:z.object({valid:z.boolean(),complete:z.boolean(),errors:z.array(z.string())}).strict(),
  steps:z.array(TraceStepSchema),
  events:z.array(z.object({eventId:text,traceId:text,stepId:text,parentStepId:nullableText,sequence:count,timestamp:text,type:text,
    category:z.enum(['run','model','tool','backend','process','workflow','context','memory']),status,error:TraceErrorSchema.nullable(),attributes:attrs}).strict()),
  errors:z.array(z.object({eventId:text,stepId:text,error:TraceErrorSchema}).strict()),
}).strict().superRefine((value,ctx)=>{
  const ids=new Set(value.steps.map(s=>s.stepId)),events=new Set(value.events.map(e=>e.eventId));
  if(ids.size!==value.steps.length||events.size!==value.events.length)ctx.addIssue({code:'custom',message:'duplicate structured identity'});
  if(value.runId!==value.traceId||value.source.eventCount!==value.events.length)ctx.addIssue({code:'custom',message:'structured trace identity/count mismatch'});
  if(value.integrity.valid!==!value.integrity.errors.length)ctx.addIssue({code:'custom',message:'structured integrity mismatch'});
  for(const step of value.steps)if((step.parentStepId!==null&&!ids.has(step.parentStepId))||step.eventIds.some(id=>!events.has(id)))ctx.addIssue({code:'custom',message:'unknown step parent or event'});
  for(const event of value.events)if(!ids.has(event.stepId)||event.traceId!==value.traceId||event.parentStepId!==value.steps.find(s=>s.stepId===event.stepId)?.parentStepId)ctx.addIssue({code:'custom',message:'invalid event correlation'});
});
export type StructuredTrace = z.infer<typeof StructuredTraceSchema>;
export type TraceStep = z.infer<typeof TraceStepSchema>;
type Json = z.infer<ReturnType<typeof z.json>>;
type JsonRecord = Record<string,Json>;
const str=(value:unknown):string|null=>typeof value==='string'&&value.length>0?value:null;
const num=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const json=(value:unknown):Json=>value===undefined?null:JSON.parse(JSON.stringify(value));
const metadata=(value:Record<string,unknown>):JsonRecord=>json(value) as JsonRecord;
const bindingInfo=(value:Record<string,unknown>):JsonRecord=>metadata({bindingId:str(value.id)??str(value.bindingId),proxyName:str(value.proxy_name)??str(value.proxyName),
  originalName:str(value.original_name)??str(value.originalName),sourceSlug:str(value.source_slug)??str(value.sourceSlug),channel:str(value.channel),action:str(value.action)});
function elapsed(start:string|null,end:string|null):number|null {
  if(!start||!end)return null;const duration=Date.parse(end)-Date.parse(start);return Number.isSafeInteger(duration)&&duration>=0?duration:null;
}
function normalizeError(value:unknown,category:z.infer<typeof TraceErrorSchema>['category'],fallback?:string):z.infer<typeof TraceErrorSchema>|null {
  const record=object(value),message=str(record.message)??str(value)??fallback;if(!message)return null;
  const raw=str(record.code)??message.replace(/^(?:Error|DOMException|AbortError|TimeoutError):\s*/,'').split(/[:\s]/)[0];
  const code=/^[a-zA-Z0-9_.-]+$/.test(raw)?raw:'unknown_error';
  return{code,message,category,retryable:null};
}
/** Deterministic public projection. Native SDK transcripts/thinking and credentials are not inputs. */
export function projectStructuredTrace(events:TraceEvent[],validationErrors:string[],source:{path?:string;sha256?:string}={}):StructuredTrace {
  if(!events.length)throw Error('trace_not_found');
  const first=events[0],runId=first.runId,runStepId=runId+':run',steps:TraceStep[]=[],normalized:StructuredTrace['events']=[],errors:StructuredTrace['errors']=[];
  function step(stepId:string,kind:TraceStep['kind'],name:string,parentStepId:string|null):TraceStep {
    const existing=steps.find(s=>s.stepId===stepId);if(existing)return existing;
    const value:TraceStep={stepId,parentStepId,kind,name,status:'pending',timing:{requestedAt:null,startedAt:null,endedAt:null,durationMs:null,executionDurationMs:null},
      correlation:{iteration:null,requestId:null,sdkToolCallId:null,bindingId:null,stageId:null,sessionId:null},input:null,output:null,error:null,resultStatus:null,attributes:{},usage:[],eventIds:[]};
    steps.push(value);return value;
  }
  const root=step(runStepId,'run','agent.run',null),calls=new Map<string,TraceStep>(),sdkCalls=new Map<string,TraceStep>(),models=new Map<number,TraceStep>(),bindings=new Map<string,Record<string,unknown>>();
  const stages=new Map<string,TraceStep>();let currentModel:TraceStep|undefined,executing:TraceStep|undefined,context:Record<string,unknown>|undefined;
  let terminal:TraceEvent|undefined,usageSummary:Record<string,unknown>={},knownTokens=0,usageRecords=0,unknownUsageRecords=0,auxiliaryUsageRecords=0;
  const terminalTypes=['run_completed','run_failed','run_cancelled'];
  for(const [index,event]of events.entries()){
    const d=event.data,eventId=runId+':event:'+(index+1);let owner=root,category:StructuredTrace['events'][number]['category']='run',eventStatus:TraceStep['status']='completed';
    let eventError:z.infer<typeof TraceErrorSchema>|null=null;
    const requestId=str(d.requestId),sdkId=str(d.sdkToolCallId),iteration=num(d.iteration);
    if(event.type==='run_started'){root.timing.requestedAt=root.timing.startedAt=event.timestamp;root.status='running';root.input=json(d.task);root.attributes=metadata({mode:d.mode,permissionMode:d.permissionMode,engine:d.engine,model:d.model,...(d.agentPrompts?{agentPrompts:d.agentPrompts}:{})});}
    if(event.type==='context_prepared'){
      category='context';context=d;
      for(const tool of Array.isArray(d.tools)?d.tools:[]){const binding=object(tool);if(str(binding.bindingId))bindings.set(String(binding.bindingId),binding);}
    }
    if(event.type==='model_requested'){
      owner=step(runId+':model:'+(index+1),'model','model.turn',runStepId);owner.status='running';owner.timing.requestedAt=owner.timing.startedAt=event.timestamp;
      owner.correlation.iteration=iteration;owner.input=json({contextChars:d.contextChars,context:context??null});owner.attributes=metadata({purpose:'turn',model:first.data.model??null});
      currentModel=owner;if(iteration!==null)models.set(iteration,owner);category='model';eventStatus='running';
    }
    if(['decision_made','provider_rejected','response_revision_requested'].includes(event.type)){
      owner=(iteration!==null?models.get(iteration):undefined)??currentModel??root;category='model';owner.timing.endedAt=event.timestamp;
      if(event.type==='decision_made'){owner.output=json(d.decision);owner.status='completed';}
      else if(event.type==='response_revision_requested'){owner.status='completed';owner.attributes.responseRevision=metadata({length:d.length,limit:d.limit});}
      else{owner.status='failed';eventError=normalizeError(d.reason,'model');owner.error=eventError;eventStatus='failed';}
    }
    if(event.type==='model_usage'){
      category='model';const purpose=str(d.purpose)??'turn',total=reportedTokens(d.usage);
      usageRecords++;if(total===undefined)unknownUsageRecords++;else knownTokens+=total;
      if(purpose==='turn'||purpose==='rejected')owner=(iteration!==null?models.get(iteration):undefined)??currentModel??root;
      else{auxiliaryUsageRecords++;owner=step(runId+':model-usage:'+(index+1),'model','model.'+purpose,runStepId);owner.status='unknown';owner.timing.endedAt=event.timestamp;owner.correlation.iteration=iteration;owner.attributes=metadata({purpose,timingAvailable:false,completionNotAsserted:true});}
      owner.usage.push(metadata({purpose,reported:d.usage,cache:d.cache??null,totalTokens:total??null}));
    }
    if(requestId){
      category='tool';owner=calls.get(requestId)??step(runId+':tool:'+requestId,'tool',str(d.toolName)??'tool.call',currentModel?.stepId??runStepId);calls.set(requestId,owner);
      owner.correlation.requestId=requestId;
      if(sdkId){owner.correlation.sdkToolCallId=sdkId;sdkCalls.set(sdkId,owner);}
      if(str(d.bindingId))owner.correlation.bindingId=String(d.bindingId);
      if(!owner.timing.requestedAt)owner.timing.requestedAt=event.timestamp;
      const binding=object(d.binding);if(str(binding.id)){owner.correlation.bindingId=String(binding.id);owner.name=str(binding.proxy_name)??owner.name;owner.attributes.binding=bindingInfo(binding);}
      const cached=owner.correlation.bindingId?bindings.get(owner.correlation.bindingId):undefined;
      if(cached)owner.attributes.binding=bindingInfo(cached);
      if(event.type==='pre_tool_use_request'){owner.name=String(d.toolName);owner.input=json(d.input);owner.attributes.argsHash=json(d.argsHash);eventStatus='pending';}
      if(event.type==='policy_decision'){owner.attributes.permission=metadata({mode:d.effectiveMode,decision:d.decision,reason:d.reason});if(d.decision==='BLOCK')owner.status=eventStatus='blocked';}
      if(event.type==='approval_resolved'){owner.attributes.approval=json(d);if(d.decision!=='approved')owner.status=eventStatus='blocked';}
      if(event.type==='pre_tool_use_response'){owner.attributes.preToolUse=metadata({action:d.action,reason:d.reason,effectiveMode:d.effectiveMode});if(d.action==='block')owner.status=eventStatus='blocked';}
      if(event.type==='execution_started'){owner.timing.startedAt=event.timestamp;owner.status=eventStatus='running';executing=owner;}
      if(event.type==='execution_finished'){
        owner.timing.endedAt=event.timestamp;const blocked=owner.status==='blocked';owner.status=blocked?'blocked':d.state==='completed'?'completed':d.state==='cancelled'?'cancelled':d.state==='unknown'?'unknown':'failed';eventStatus=owner.status;
        owner.output=json(d.result);eventError=normalizeError(d.error,blocked?'permission':'tool');owner.error=eventError;
        if(executing===owner)executing=undefined;
      }
    }
    if(event.type.startsWith('backend_')){
      category='backend';const stageId=str(d.stageId)??'missing-stage:'+index,parent=requestId?calls.get(requestId):undefined;
      owner=stages.get(stageId)??step(runId+':backend:'+stageId,'backend',str(d.backend)??'backend.call',parent?.stepId??runStepId);stages.set(stageId,owner);
      owner.correlation.stageId=stageId;owner.correlation.requestId=requestId;owner.input=parent?.input??null;
      if(!owner.timing.requestedAt)owner.timing.requestedAt=event.timestamp;
      if(event.type==='backend_policy')owner.attributes.permission=metadata({mode:d.effectiveMode,decision:d.decision,reason:d.reason});
      if(event.type==='backend_started'){owner.status=eventStatus='running';owner.timing.startedAt=event.timestamp;}
      if(event.type==='backend_finished'){owner.timing.endedAt=event.timestamp;owner.status=eventStatus=d.state==='completed'?'completed':d.state==='cancelled'?'cancelled':'failed';eventError=normalizeError(d.error,'tool');owner.error=eventError;}
    }
    if(event.type==='observation_added'){
      category='tool';owner=(sdkId?sdkCalls.get(sdkId):undefined)??[...calls.values()].reverse().find(s=>s.name===d.name&&!s.attributes.observationRecorded)
        ??step(runId+':observation:'+(index+1),'tool',str(d.name)??'tool.observation',currentModel?.stepId??runStepId);
      if(sdkId)owner.correlation.sdkToolCallId=sdkId;
      owner.output=json(d.observation);owner.attributes.observationRecorded=true;
      const result=object(d.observation);owner.resultStatus=str(result.status);
      if(!owner.timing.endedAt)owner.timing.endedAt=event.timestamp;
      if(!owner.correlation.requestId){owner.attributes.hostExecutionObserved=false;owner.status=result.status==='tool_failed'?'failed':'unknown';}
      if(result.error||['auth_failed','rate_limited','timeout','parse_failed','cancelled','unknown','tool_failed'].includes(String(result.status))){eventError=normalizeError(result.error,owner.status==='blocked'?'permission':result.status==='tool_failed'?'tool':'source',str(result.status)??undefined);owner.error=eventError;}
      eventStatus=owner.status;
    }
    if(event.type==='agent_process'){
      category='process';const sessionId=str(d.sessionId)??'unknown';owner=step(runId+':process:'+sessionId,'process','agent.process',runStepId);owner.correlation.sessionId=sessionId;owner.attributes=metadata(d);
      if(d.state==='started'){owner.timing.requestedAt=owner.timing.startedAt=event.timestamp;owner.status='running';}
      if(d.state==='exited'){owner.timing.endedAt=event.timestamp;const code=num(d.code??d.exitCode);owner.status=code===0?'completed':code===null?'unknown':'failed';}
      eventStatus=owner.status;
    }
    if(/^(plan_|evidence_saved)/.test(event.type)){owner=executing??root;category='workflow';if(d.error){eventError=normalizeError(d.error,'tool');eventStatus='failed';}}
    if(event.type==='session_memory_updated')category='memory';
    if(event.type==='budget_exceeded'){owner=requestId?calls.get(requestId)??root:currentModel??root;eventError=normalizeError(d.error,'budget',str(d.budget)??'budget_exceeded');eventStatus='failed';}
    if(event.type==='usage_reported')usageSummary=d;
    if(terminalTypes.includes(event.type)){
      terminal=event;owner=root;root.timing.endedAt=event.timestamp;root.status=event.type==='run_failed'?'failed':event.type==='run_cancelled'?'cancelled':d.status==='partial'?'partial':'completed';
      root.output=json({response:d.response??null,report:d.report??null,gaps:d.gaps??[]});eventError=normalizeError(d.error,'runtime');root.error=eventError;eventStatus=root.status;
    }
    const attributes={...d};for(const key of ['task','input','result','observation','decision','usage','modelUsage','response','report'])delete attributes[key];
    if(!eventError)eventStatus=owner.status;
    owner.eventIds.push(eventId);
    normalized.push({eventId,traceId:runId,stepId:owner.stepId,parentStepId:owner.parentStepId,sequence:event.sequence,timestamp:event.timestamp,type:event.type,category,status:eventStatus,error:eventError,attributes:metadata(attributes)});
    if(eventError)errors.push({eventId,stepId:owner.stepId,error:eventError});
  }
  for(const s of steps){
    if(terminal&&['running','pending'].includes(s.status)){s.status=terminal.type==='run_cancelled'?'cancelled':terminal.type==='run_failed'?'failed':'unknown';if(!s.timing.endedAt)s.timing.endedAt=terminal.timestamp;
      if(s.kind==='model'&&terminal.data.error){s.error=normalizeError(terminal.data.error,'model');s.attributes.closedByRunTerminal=true;}}
    s.timing.durationMs=elapsed(s.timing.requestedAt,s.timing.endedAt);s.timing.executionDurationMs=elapsed(s.timing.startedAt,s.timing.endedAt);
  }
  const rootStatus=!terminal?'incomplete':terminal.type==='run_failed'?'failed':terminal.type==='run_cancelled'?'cancelled':terminal.data.status==='partial'?'partial':'complete';
  const errorsList=[...new Set(validationErrors)],totalFromSummary=num(usageSummary.totalTokens),knownTotal=usageRecords>0&&unknownUsageRecords===0?knownTokens:null;
  return StructuredTraceSchema.parse({schemaVersion:STRUCTURED_TRACE_VERSION,traceId:runId,runId,taskId:first.taskId,status:rootStatus,
    input:{task:json(first.data.task),mode:str(first.data.mode),permissionMode:str(first.data.permissionMode),engine:str(first.data.engine),model:json(first.data.model)},
    output:{response:typeof terminal?.data.response==='string'?terminal.data.response:null,report:str(terminal?.data.report),gaps:Array.isArray(terminal?.data.gaps)?terminal.data.gaps.filter((g):g is string=>typeof g==='string'):[]},
    timing:{startedAt:root.timing.startedAt,endedAt:root.timing.endedAt,durationMs:num(usageSummary.durationMs)??root.timing.durationMs},
    summary:{modelRounds:events.filter(e=>e.type==='model_requested').length,auxiliaryUsageRecords,toolRequests:calls.size,
      toolExecutions:events.filter(e=>e.type==='execution_started').length,backendExecutions:events.filter(e=>e.type==='backend_started').length,
      knownTokens,totalTokens:usageSummary.usageAvailable===true&&totalFromSummary!==null?totalFromSummary:knownTotal,unknownUsageRecords,physicalModelRequests:num(usageSummary.physicalModelRequests),actualCost:null},
    source:{format:'trace-events-jsonl',path:source.path??null,sha256:source.sha256??null,schemaVersions:[...new Set(events.map(e=>e.schemaVersion??1))],eventCount:events.length},
    integrity:{valid:errorsList.length===0,complete:Boolean(terminal),errors:errorsList},steps,events:normalized,errors});
}
