import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, renameSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, sha256, within, type LoadedCase } from './dataset.ts';
import { collectProjection, grade, invalidResult, inventory, verifyInventory, preserveControllerFailures, GRADER_VERSION, type EvalResult } from './grader.ts';
import { summarizePenalty, PENALTY_PROFILE, AGENT_TYPES, type AgentType } from './penalty.ts';
import type { WorkerObservation } from './contracts.ts';
import { readModelConfig, type ModelConfig } from '@cwatch/shared/config/models';
import { buildExecutionInput } from './execution-input.ts';

const workspace=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
export const workerFailureKind=(hasSutEvidence:boolean)=>hasSutEvidence?'sut_failure':'harness_failure';
function sourceVersion(){
  let commit:string|null=null,sourceDigest:string|null=null;
  try{commit=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:workspace,maxBuffer:4000000}).toString().split('\0')
      .filter(p=>/^(apps\/|packages\/|scripts\/|skills\/|evals\/|package(?:-lock)?\.json$)/.test(p)&&existsSync(resolve(workspace,p))).sort();
    sourceDigest=sha256(JSON.stringify(files.map(file=>[file,sha256(readFileSync(resolve(workspace,file)))])));
  }catch{/* Exported archives without Git retain the explicit null, never a fabricated commit. */}
  return{commit,sourceDigest,node:process.version,lockSha256:sha256(readFileSync(resolve(workspace,'package-lock.json'))),
    graderVersion:GRADER_VERSION,graderSha256:sha256(readFileSync(fileURLToPath(new URL('./grader.ts',import.meta.url)))),
    sdkVersion:JSON.parse(readFileSync(resolve(workspace,'node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8')).version};
}
async function runWorker(input:unknown,output:string,probe:string,signal?:AbortSignal,credentials?:ModelConfig):Promise<{ok:boolean;reason:string|null;started:boolean}>{
  const readable=['package.json','node_modules','packages','scripts/evaluation','skills/general-agent/SKILL.md'].map(path=>resolve(workspace,path));
  const args=['--use-env-proxy','--permission',...readable.map(path=>'--allow-fs-read='+path),'--allow-fs-read='+output,'--allow-fs-write='+output,
    '--experimental-transform-types',fileURLToPath(new URL('./worker.ts',import.meta.url)),output,probe];
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)&&value!==undefined));
  return await new Promise((resolveRun)=>{
    let outputText='',errors='',settled=false,timedOut=false,started=false;
    const child=spawn(process.execPath,args,{cwd:workspace,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    const abort=()=>{timedOut=true;child.kill('SIGKILL');};
    const timer=setTimeout(abort,credentials?195000:45000);signal?.addEventListener('abort',abort,{once:true});
    const finish=(ok:boolean,reason:string|null)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      // Worker env contains no inherited credentials; still cap diagnostic output.
      const clean=(text:string)=>credentials?.apiKey?text.split(credentials.apiKey).join('[REDACTED]'):text;
      save(join(output,'worker.log.json'),{stdout:clean(outputText.slice(0,64000)),stderr:clean(errors.slice(0,64000))});resolveRun({ok,reason:reason?clean(reason):null,started});};
    child.stdout.on('data',chunk=>{outputText+=String(chunk);if(outputText.includes('"type":"started"'))started=true;if(outputText.length>1000000)abort();});
    child.stderr.on('data',chunk=>{errors+=String(chunk);if(errors.length>1000000)abort();});
    child.on('error',error=>finish(false,'worker_spawn_failed:'+error.message));
    child.on('close',code=>{
      let messages:Array<{type:string;code?:string}>=[];try{messages=outputText.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch{finish(false,'invalid_worker_protocol');return;}
      const failure=messages.find(m=>m.type==='harness_error');
      finish(code===0&&messages.some(m=>m.type==='finished'),timedOut?'worker_timeout':failure?.code??(code===0?null:'worker_exit:'+code));
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({input,...(credentials?{credentials}:{})}));if(signal?.aborted)abort();
  });
}
export function summarize(results:EvalResult[],penaltyOptions:{expectedTrials?:number;agentType?:AgentType}={}){
  const totals={planned:results.length,pass:0,fail:0,needs_review:0,invalid:0,executionPassed:0};
  for(const r of results){totals[r.verdict]++;if(r.executionPassed)totals.executionPassed++;}
  const valid=totals.planned-totals.invalid;
  const group=(key:'layer'|'familyId')=>Object.fromEntries([...new Set(results.map(r=>r[key]))].map(value=>{
    const rows=results.filter(r=>r[key]===value);return[value,{total:rows.length,executionPassed:rows.filter(r=>r.executionPassed).length,pass:rows.filter(r=>r.verdict==='pass').length,fail:rows.filter(r=>r.verdict==='fail').length,needsReview:rows.filter(r=>r.verdict==='needs_review').length,invalid:rows.filter(r=>r.verdict==='invalid').length}];}));
  const families=group('familyId');
  const caseStability=Object.fromEntries([...new Set(results.map(r=>r.caseId))].map(id=>{const rows=results.filter(r=>r.caseId===id);return[id,{attempts:rows.length,executionPassed:rows.filter(r=>r.executionPassed).length,allAttemptsPassed:rows.every(r=>r.executionPassed)}];}));
  const scenarioCoverage = Object.fromEntries(['activation','core_logic','artifact_quality','resilience'].map(category => [category,
    Object.fromEntries(['positive','negative'].map(polarity => { const rows = results.filter(r => r.coverage?.category === category && r.coverage.polarity === polarity);
      return [polarity, { planned:rows.length, executionPassed:rows.filter(r => r.executionPassed).length, fail:rows.filter(r => r.verdict === 'fail').length, needsReview:rows.filter(r => r.verdict === 'needs_review').length, invalid:rows.filter(r => r.verdict === 'invalid').length }]; }))]));
  return{...totals,valid,explicitPassRate:valid?totals.pass/valid:null,explicitFailureRate:valid?totals.fail/valid:null,
    effectiveCoverage:totals.planned?valid/totals.planned:null,layers:group('layer'),families,caseStability,scenarioCoverage,unclassifiedScenarioAttempts:results.filter(r => !r.coverage).length,
    durationMsByRun:results.map(r=>({caseId:r.caseId,attempt:r.attempt,durationMs:r.durationMs})),
    familyMacroExecutionRate:Object.keys(families).length?Object.values(families).reduce((sum,g)=>sum+g.executionPassed/g.total,0)/Object.keys(families).length:null,
    knownFixtureMaintenanceTokens:results.filter(r=>r.usage?.mode==='fixture').reduce((sum,r)=>sum+(r.usage?.maintenanceTokens??0),0),
    physicalFixtureModelRequests:results.filter(r=>r.usage?.mode==='fixture').reduce((sum,r)=>sum+(r.usage?.physicalModelRequests??0),0),
    knownLiveModelTokens:results.filter(r=>r.usage?.mode==='live_model').reduce((sum,r)=>sum+(r.usage?.mainTaskTokens??0)+(r.usage?.maintenanceTokens??0),0),
    physicalLiveModelRequests:results.filter(r=>r.usage?.mode==='live_model').reduce((sum,r)=>sum+(r.usage?.physicalModelRequests??0),0),
    incompleteLiveUsageRuns:results.filter(r=>r.usage?.mode==='live_model'&&r.usage.completeness!=='known').length,
    measuredLiveModelAccuracy:null,actualLiveModelCost:null,penalty:summarizePenalty(results,penaltyOptions),
    executionGate:results.length>0&&results.every(r=>r.executionPassed),releaseGate:results.length>0&&results.every(r=>r.releaseEligible)};
}
export interface BatchOptions{dataset?:string;out?:string;caseId?:string;repeat?:number;requireApproved?:boolean;signal?:AbortSignal;realModel?:boolean;split?:'regression'|'holdout';agentType?:AgentType;scoreGate?:boolean}
export async function runBatch(options:BatchOptions={}){
  const data=loadDataset(options.dataset??resolve(workspace,'evals/regression/dataset.json'),workspace);
  const split=options.split??'regression';
  const entries=data.entries.filter(e=>e.value.split===split&&e.value.status!=='retired'&&
    (e.value.scope.executionMode==='frozen_tools_live_model')===Boolean(options.realModel)&&(!options.caseId||e.value.id===options.caseId));
  if(!entries.length)throw Error('no_matching_cases');
  const credentials=options.realModel?readModelConfig():undefined;
  const repeat=options.repeat??1;if(!Number.isInteger(repeat)||repeat<1||repeat>5)throw Error('repeat_must_be_1_to_5');
  const agentType=options.agentType??'critical_decision';if(!AGENT_TYPES.includes(agentType))throw Error('invalid_agent_type');
  const out=resolve(options.out??resolve(workspace,'artifacts/agent-eval'));
  if(split==='holdout'){
    if(!options.out||within(workspace,out))throw Error('holdout_output_requires_explicit_private_directory_outside_workspace');
  }else if(!within(workspace,out)||out===workspace)throw Error('eval_output_must_be_inside_workspace_subdirectory');
  // Resolve an existing ancestor before creating anything; never follow a workspace symlink into another tree.
  let ancestor=out;while(!existsSync(ancestor)){const parent=resolve(ancestor,'..');if(parent===ancestor)throw Error('output_parent_missing');ancestor=parent;}
  if(split==='regression'&&!within(realpathSync(workspace),realpathSync(ancestor)))throw Error('eval_output_symlink_escape');
  if(split==='holdout'&&within(realpathSync(workspace),realpathSync(ancestor)))throw Error('holdout_output_not_private');
  mkdirSync(out,{recursive:true});if(split==='regression'&&!within(realpathSync(workspace),realpathSync(out)))throw Error('eval_output_symlink_escape');
  const batchId='batch-'+randomUUID(),batch=join(out,batchId);mkdirSync(batch);mkdirSync(join(batch,'private'));
  const sentinel='eval-private-'+randomUUID(),probe=join(batch,'private','oracle-sentinel.txt');writeFileSync(probe,sentinel,{flag:'wx'});
  const version=sourceVersion(),startedAt=new Date().toISOString(),results:EvalResult[]=[],artifacts:Array<{caseId:string;attempt:number;directory:string;manifestSha256:string}>=[];
  mkdirSync(join(batch,'private','cases'));
  save(join(batch,'private','dataset.snapshot.json'),data.manifest);
  for(const entry of entries)writeFileSync(join(batch,'private','cases',entry.value.id+'.source'),readFileSync(entry.file),{flag:'wx'});
  for(const entry of entries)for(let attempt=1;attempt<=repeat;attempt++){
    const directory=join(batch,entry.value.id+'-'+attempt);mkdirSync(directory);
    const input=buildExecutionInput(entry.value);save(join(directory,'input.json'),input);
    const worker=options.signal?.aborted?{ok:false,reason:'batch_cancelled',started:false}:await runWorker(input,directory,probe,options.signal,credentials);
    let result:EvalResult;
    const traceRoot=join(directory,'traces'),existingTraces=existsSync(traceRoot)?readdirSync(traceRoot).filter(name=>/^[a-zA-Z0-9_-]+\.jsonl$/.test(name)):[];
    const hasEvidence=existsSync(join(directory,'observed.json'))||existingTraces.length>0;
    if(!worker.ok&&!hasEvidence)result=invalidResult(entry.value,attempt,worker.reason??'worker_failed');
    else{
      try{
        const observed:WorkerObservation=existsSync(join(directory,'observed.json'))?JSON.parse(readFileSync(join(directory,'observed.json'),'utf8')):{
          runId:existingTraces[0].slice(0,-6),status:'failed',tracePath:'traces/'+existingTraces[0],facts:{driver:'controller_after_worker_failure'},
          usage:{mode:credentials?'live_model':'fixture',mainTaskTokens:null,maintenanceTokens:null,physicalModelRequests:0,completeness:'partial'}};
        if(!existsSync(join(directory,'observed.json')))save(join(directory,'controller.observation.json'),{...observed,reason:worker.reason});
        const boundaryPath=join(directory,'boundary.json'),boundary=JSON.parse(readFileSync(boundaryPath,'utf8'));
        boundary.outputCanaryLeaked=inventory(directory).some(item=>readFileSync(join(directory,item.path),'utf8').includes(sentinel));
        boundary.configuredSecretLeaked=credentials?inventory(directory).some(item=>readFileSync(join(directory,item.path),'utf8').includes(credentials.apiKey)):false;
        writeFileSync(boundaryPath,JSON.stringify(boundary,null,2)+'\n');
        const projection=collectProjection(directory,observed,entry.value.expected_final.outputContract,entry.value.expected_final.reportContract);save(join(directory,'projection.json'),projection);result=grade(entry.value,projection,attempt);
        if(!worker.ok){preserveControllerFailures(result,['runtime.process_crash']);result.reviewIssues.push(worker.reason??'worker_failed_after_sut_started');}
      }catch(error){result=invalidResult(entry.value,attempt,'collection_failure:'+(error instanceof Error?error.message:'unknown'));
        if(workerFailureKind(hasEvidence)==='sut_failure')preserveControllerFailures(result,['observability.collection_failed']);}
    }
    const restrictedEvidence:Array<{logicalPath:string;ref:string;sha256:string}>=[];
    if(credentials&&existsSync(join(directory,'sessions'))){
      const targetRoot=join(batch,'private','raw',entry.value.id+'-'+attempt);mkdirSync(targetRoot,{recursive:true});
      for(const name of readdirSync(join(directory,'sessions'))){
        if(!/^[a-zA-Z0-9_-]+\.jsonl$/.test(name))throw Error('unexpected_private_session_filename');
        const from=resolve(directory,'sessions',name),to=resolve(targetRoot,name);
        if(!within(realpathSync(batch),realpathSync(from))||!within(realpathSync(batch),to)||existsSync(to))throw Error('private_session_path_escape');
        const digest=sha256(readFileSync(from));renameSync(from,to);
        restrictedEvidence.push({logicalPath:'sessions/'+name,ref:relative(directory,to).replaceAll('\\','/'),sha256:digest});
      }
    }
    const evidence=inventory(directory),manifest={schemaVersion:'cwatch.eval-trace-bundle.v1',batchId,caseId:entry.value.id,caseRevision:entry.value.revision,caseSha256:entry.sha256,
      datasetId:data.manifest.id,datasetVersion:data.manifest.version,datasetSha256:data.sha256,attempt,version,
      inputSha256:sha256(readFileSync(join(directory,'input.json'))),mode:entry.value.scope.executionMode,
      scorePolicy:{penaltyProfile:PENALTY_PROFILE,agentType,plannedTrialsPerCase:repeat,gate:options.scoreGate?'penalty':'required_checks',requireApproved:Boolean(options.requireApproved)},
      model:credentials?{provider:credentials.provider,id:credentials.modelId,endpointFingerprint:sha256(credentials.baseUrl??'sdk-default')}:'scripted_or_fixture_maintenance',
      isolation:{labels:'not_sent_to_worker',fileBoundary:'node_permission_probe',processNetwork:'not_os_verified'},
      frozenCaseRef:'../private/cases/'+entry.value.id+'.source',evidence,restrictedEvidence};
    save(join(directory,'manifest.json'),manifest);
    const integrity=verifyInventory(directory,evidence);if(integrity.length)preserveControllerFailures(result,['observability.evidence_tampered']);
    save(join(directory,'result.'+GRADER_VERSION+'.json'),result);results.push(result);
    artifacts.push({caseId:entry.value.id,attempt,directory:relative(out,directory).replaceAll('\\','/'),manifestSha256:sha256(readFileSync(join(directory,'manifest.json')))});
    if(split!=='holdout')console.log(`${result.executionPassed?'CHECKS_PASS':result.verdict.toUpperCase()} ${entry.value.id} attempt=${attempt} verdict=${result.verdict}`);
  }
  const report={schemaVersion:'cwatch.eval-report.v1',batchId,startedAt,endedAt:new Date().toISOString(),datasetId:data.manifest.id,datasetVersion:data.manifest.version,datasetSha256:data.sha256,
    executionMode:options.realModel?'frozen_tools_live_model':'deterministic',split,version,plannedTrialsPerCase:repeat,
    scorePolicy:{penaltyProfile:PENALTY_PROFILE,agentType,gate:options.scoreGate?'penalty':'required_checks',requireApproved:Boolean(options.requireApproved)},metrics:summarize(results,{expectedTrials:repeat,agentType}),results,artifacts,
    limits:['Candidate labels require human review.','Fixture tools are explicitly simulated; they do not establish live source availability.','Node file/process permission checks do not prove OS network isolation.','No independent holdout or production traffic is claimed.',
      options.realModel?'Actual SDK session in a permission-restricted eval worker; production IPC transport is covered separately by engineering tests.':'Scripted decisions and fixture usage do not measure live model quality or actual monetary cost.']};
  save(join(batch,'report.json'),report);
  const table=['| Case | attempt | Runtime | 判分 | 检查 | 单次分 | ≥80 |','|---|---:|---|---|---|---:|---|',...results.map(r=>`| [${r.caseId}](${r.caseId}-${r.attempt}/result.${r.graderVersion}.json) | ${r.attempt} | ${r.runStatus??'未执行'} | ${r.verdict} | ${r.executionPassed?'通过':'未通过'} | ${r.penalty?.score??'未知'} | ${r.penalty?.passed?'是':'否'} |`)].join('\n');
  const show=(value:boolean|null)=>value===null?'未完成':value?'是':'否';
  const penaltyTable=['| Case / revision | Trials | pass@k | pass^k | 类型容忍度满足 | 用例分 |','|---|---:|---|---|---|---:|',...report.metrics.penalty.cases.map(c=>
    `| ${c.caseId} / ${c.caseRevision} | ${c.trialCount}/${c.expectedTrials} | ${show(c.passAtK)} | ${show(c.passPowK)} | ${show(c.toleranceSatisfied)} | ${c.caseScore.toFixed(2)} |`)].join('\n');
  const coverageTable = ['| 场景 | 正例 执行通过/计划 | 负例 执行通过/计划 |','|---|---:|---:|',...Object.entries(report.metrics.scenarioCoverage).map(([category, rows]) =>
    `| ${category} | ${rows.positive.executionPassed}/${rows.positive.planned} | ${rows.negative.executionPassed}/${rows.negative.planned} |`)].join('\n');
  const markdown=['# Agent 契约评测',`批次：${batchId}`,`执行检查 ${report.metrics.executionPassed}/${report.metrics.planned}；人工批准后正式通过 ${report.metrics.pass}；待复核 ${report.metrics.needs_review}；失败 ${report.metrics.fail}；无效 ${report.metrics.invalid}。`,
    `执行门禁 ${report.metrics.executionGate?'PASS':'FAIL'}；发布门禁 ${report.metrics.releaseGate?'PASS':'BLOCKED'}。真实模型准确率与实际费用未评估。`,table,
    `负分制：100 分起，80 分达标，超过 5 分钟每开始 1 分钟扣 10 分。所有 Trial 达标才取平均，否则用例分为 0。Agent 类型 ${agentType}；容忍失败率 ${report.metrics.penalty.allowedFailureRate*100}%，容忍度仅作独立观测，不改用例计分。`,
    penaltyTable,'单次分数达标与原有必过项/人工审核门禁分别展示；数据不足记未知，不视为满分。',coverageTable,`未标记四类场景的历史用例尝试：${report.metrics.unclassifiedScenarioAttempts}。`,report.limits.map(s=>'- '+s).join('\n')].join('\n\n');
  writeFileSync(join(batch,'report.md'),markdown,{flag:'wx'});
  // Convenience pointer only; immutable per-batch evidence is never replaced.
  writeFileSync(join(out,'latest.json'),JSON.stringify({batchId,report:relative(out,join(batch,'report.json')).replaceAll('\\','/'),metrics:report.metrics},null,2)+'\n');
  return{report,path:join(batch,'report.json'),gate:options.scoreGate?report.metrics.penalty.strictGate&&(!options.requireApproved||report.metrics.releaseGate):options.requireApproved?report.metrics.releaseGate:report.metrics.executionGate};
}

export function compareReports(before:{datasetSha256:string;results:EvalResult[];scorePolicy?:unknown;plannedTrialsPerCase?:number},after:{datasetSha256:string;results:EvalResult[];scorePolicy?:unknown;plannedTrialsPerCase?:number}){
  if(before.datasetSha256!==after.datasetSha256)throw Error('incomparable_dataset_revision');
  if(JSON.stringify(before.scorePolicy??null)!==JSON.stringify(after.scorePolicy??null)||before.plannedTrialsPerCase!==after.plannedTrialsPerCase)throw Error('incomparable_score_policy');
  if(before.results.length&&after.results.length&&JSON.stringify([...new Set(before.results.map(r=>r.graderVersion))].sort())!==JSON.stringify([...new Set(after.results.map(r=>r.graderVersion))].sort()))throw Error('incomparable_grader_version');
  const key=(r:EvalResult)=>r.caseId+'@'+r.caseRevision+'#'+r.attempt,previous=new Map(before.results.map(r=>[key(r),r]));
  const regressions=after.results.filter(r=>previous.get(key(r))?.executionPassed&&!r.executionPassed).map(r=>r.caseId);
  return{regressions:[...new Set(regressions)],improvements:[...new Set(after.results.filter(r=>previous.has(key(r))&&!previous.get(key(r))!.executionPassed&&r.executionPassed).map(r=>r.caseId))],
    missing:before.results.filter(r=>!after.results.some(a=>key(a)===key(r))).map(r=>key(r))};
}
