import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { qualityReport } from './quality.ts';
import { readArchivedCase } from './operations.ts';
import type { EvalResult } from './grader.ts';
import type { WorkerObservation } from './contracts.ts';
import { automaticAssessment } from './automatic.ts';
import { baselineForCase } from './baseline.ts';
import { assessRegressionBatch } from './regression-policy.ts';

const sumKnown=(values:Array<number|null>)=>values.every(v=>v!==null)?values.reduce<number>((s,v)=>s+v!,0):null;
const show=(value:unknown)=>value===null||value===undefined?'未知 / 待确认':String(value);
const cell=(value:unknown)=>show(value).replaceAll('|','\\|').replaceAll('\n',' ');
function automaticDeductions(value:ReturnType<typeof automaticAssessment>){
  const deductions:Array<{group:string;dimensions:string[];points:number;reason:string}>=[];
  if(value.vetoes.length)deductions.push({group:'result:veto',dimensions:[...new Set(value.vetoes.map(v=>v.dimension))],points:-100,reason:value.vetoes.map(v=>v.reason).join('; ')});
  if(value.processDeduction)deductions.push({group:'process:rubric',dimensions:['trajectory'],points:value.processDeduction,reason:'Assigned Rubric process findings failed; automatic scope only'});
  if(value.efficiencyDeduction)deductions.push({group:'efficiency:analysis_time',dimensions:['cost'],points:value.efficiencyDeduction,reason:'Each started minute beyond five minutes costs 10 points'});
  return deductions;
}
/** File-only report generation; it never calls a model or substitutes for a human reviewer. */
export function saveDetailedEvaluationReport(reportFile:string,options:{baselineRoot?:string;regression?:boolean;evaluationMode?:'automatic'|'human_review'}={}){
  const evaluationMode=options.evaluationMode??'automatic',humanRequested=evaluationMode==='human_review';
  const raw=JSON.parse(readFileSync(reportFile,'utf8')) as {batchId:string;startedAt:string;endedAt:string;plannedTrialsPerCase?:number;version:unknown;results:EvalResult[]};
  const quality=qualityReport(reportFile),batch=dirname(reportFile);
  const trials=raw.results.map(row=>{
    const assessed=quality.results.find(a=>a.caseId===row.caseId&&a.attempt===row.attempt)!;
    if(!row.runId||row.verdict==='invalid')return {caseId:row.caseId,title:row.caseId,caseRevision:row.caseRevision,taskGroup:row.familyId,attempt:row.attempt,runId:row.runId,
      runStatus:row.runStatus,evaluationStatus:assessed.verdict,complete:false,score:assessed.penalty.score,numericPassed:null,model:null,prompt:null,
      durationMs:row.durationMs,totalTokens:null,judgeTokens:null,actualCost:null,toolCalls:null,trace:null,traceEvents:null,answer:null,
      automatic:null,adjudications:[],codeChecks:row.checks,deductions:assessed.penalty.deductions,unknownCheckIds:assessed.penalty.unknownCheckIds,failures:row.failures,reviewIssues:row.reviewIssues,judge:null,human:null};
    const archive=readArchivedCase(reportFile,row.caseId,row.attempt),manifest=JSON.parse(readFileSync(join(archive.directory,'manifest.json'),'utf8'));
    const observed=JSON.parse(readFileSync(join(archive.directory,'observed.json'),'utf8')) as WorkerObservation;
    const projection=JSON.parse(readFileSync(join(archive.directory,'projection.json'),'utf8'));
    const codeResult='rules' in assessed?assessed.rules:row;
    const history='history' in assessed?assessed.history:[],judgeAttempts=history.filter(h=>h.kind==='llm');
    const judgeTokens=sumKnown(judgeAttempts.map(h=>h.physicalRequests===0?0:h.totalTokens));
    const toRef=(path:string)=>relative(batch,join(archive.directory,path)).replaceAll('\\','/');
    return {caseId:row.caseId,title:archive.value.title,caseRevision:row.caseRevision,taskGroup:row.familyId,attempt:row.attempt,runId:row.runId,runStatus:row.runStatus,
      evaluationStatus:assessed.verdict,complete:assessed.penalty.complete,score:assessed.penalty.score,
      numericPassed:assessed.penalty.complete?assessed.penalty.passed:null,model:manifest.model,
      prompt:archive.value.input.scenario.driver==='runtime'?archive.value.input.scenario.instruction:null,
      durationMs:row.durationMs,totalTokens:projection.cost?.totalTokens??null,judgeTokens,actualCost:projection.cost?.actualCost??null,
      toolCalls:projection.cost?.toolCalls??null,trace:observed.structuredTracePath?toRef(observed.structuredTracePath):null,traceEvents:toRef(observed.tracePath),
      automatic:automaticAssessment(archive.value,codeResult.checks,codeResult.durationMs,'llm' in assessed?assessed.llm:null,'human' in assessed?assessed.human:null,'incompleteJudgeAssessments' in assessed?assessed.incompleteJudgeAssessments:0),
      adjudications:'adjudications' in assessed?assessed.adjudications:[],answer:observed.facts.response??null,codeChecks:codeResult.checks,deductions:assessed.penalty.deductions,unknownCheckIds:assessed.penalty.unknownCheckIds,
      failures:codeResult.failures,reviewIssues:codeResult.reviewIssues,judge:'llm' in assessed?assessed.llm:null,human:'human' in assessed?assessed.human:null};
  }).map(trial=>{
    const humanApplicable=Boolean(trial.automatic?.manualRequired.length);
    const automatic=trial.automatic?{...trial.automatic,humanReviewRequested:humanRequested,
      manualRequired:humanRequested?trial.automatic.manualRequired:[],
      dimensions:trial.automatic.dimensions.map(d=>({...d,human:!humanRequested&&d.human==='pending'?'not_requested':d.human}))}:null;
    return {...trial,automatic,humanReview:{requested:humanRequested&&humanApplicable,status:trial.adjudications.length?'rejected':!humanApplicable?'not_applicable':humanRequested?(trial.human?'recorded':'pending'):'not_requested',historicalRecord:trial.human?.id??null},
      complete:humanRequested?trial.complete:automatic?.complete??false,score:humanRequested?trial.score:automatic?.score??null,
      evaluationStatus:humanRequested?trial.evaluationStatus:automatic?.verdict??'invalid',numericPassed:humanRequested?trial.numericPassed:automatic?.passed??false,
      deductions:humanRequested?trial.deductions:automatic?automaticDeductions(automatic):[],
      unknownCheckIds:humanRequested?trial.unknownCheckIds:automatic?.unknownCheckIds??['execution_unavailable'],
      reviewIssues:humanRequested?trial.reviewIssues:trial.reviewIssues.filter(issue=>issue!=='oracle.human_review_pending')};
  });
  const caseIds=[...new Set(trials.map(t=>t.caseId))];
  const cases=caseIds.map(caseId=>{
    const rows=trials.filter(t=>t.caseId===caseId),stability=quality.metrics.penalty.cases.find(c=>c.caseId===caseId)!;
    const autoComplete=rows.length===stability.expectedTrials&&stability.comparable&&new Set(rows.map(r=>r.attempt)).size===rows.length
      &&rows.every(r=>r.automatic?.complete)&&Array.from({length:stability.expectedTrials},(_,i)=>i+1).every(n=>rows.some(r=>r.attempt===n));
    const autoPassed=autoComplete&&rows.every(r=>r.automatic!.passed);
    const autoFailed=rows.some(r=>r.automatic?.verdict==='fail'||r.runStatus==='failed'||r.runStatus==='cancelled');
    const autoScore=autoFailed?0:autoComplete?(autoPassed?rows.reduce((s,r)=>s+r.automatic!.score!,0)/rows.length:0):null;
    const selectedStability=humanRequested?{...stability,failedTrials:rows.filter(r=>typeof r.score==='number'&&r.score<80).length,pendingTrials:rows.filter(r=>!r.complete).length}:{...stability,complete:autoComplete,passedTrials:rows.filter(r=>r.automatic?.passed).length,
      failedTrials:rows.filter(r=>r.automatic?.verdict==='fail'||r.runStatus==='failed'||r.runStatus==='cancelled').length,
      pendingTrials:rows.filter(r=>!r.automatic?.complete&&r.automatic?.verdict!=='fail'&&r.runStatus!=='failed'&&r.runStatus!=='cancelled').length,
      meanTrialScore:rows.every(r=>typeof r.automatic?.score==='number')?rows.reduce((s,r)=>s+r.automatic!.score!,0)/rows.length:null,
      caseScore:autoScore,allTrialsPassed:autoPassed,passAtK:autoComplete?rows.some(r=>r.automatic!.passed):null,passPowK:autoComplete?autoPassed:null,
      failureRate:autoComplete?rows.filter(r=>!r.automatic!.passed).length/rows.length:null,toleranceSatisfied:autoComplete?autoPassed:null,
      hardBoundaryFailed:rows.some(r=>r.automatic?.vetoes.some(v=>['evidence','safety'].includes(v.dimension))),
      trials:rows.map(r=>({attempt:r.attempt,score:r.automatic?.score??null,passed:r.automatic?.passed??false,verdict:r.automatic?.verdict??'invalid'}))};
    const finalScore=rows.some(r=>r.score===0&&r.evaluationStatus==='fail')?0:stability.complete?stability.caseScore:null;
    return {caseId,title:rows[0].title,taskGroup:rows[0].taskGroup,models:rows.map(r=>r.model),executionCount:rows.length,
      baseline:rows[0].runId?baselineForCase(readArchivedCase(reportFile,caseId,rows[0].attempt).value,batch,options.baselineRoot):{status:'not_established',durationMs:null,totalTokens:null,actualCost:null,steps:null,toolCalls:null,reference:null,runId:null,reason:null},
      totalTokens:sumKnown(rows.map(r=>r.totalTokens)),judgeTokens:sumKnown(rows.map(r=>r.judgeTokens)),totalCost:sumKnown(rows.map(r=>r.actualCost)),
      averageCost:rows.every(r=>r.actualCost!==null)?rows.reduce((s,r)=>s+r.actualCost!,0)/rows.length:null,
      automatic:{complete:autoComplete,passed:autoPassed,score:autoScore},
      scoreScope:evaluationMode,humanReview:{requested:rows.some(r=>r.humanReview.requested),status:rows.some(r=>r.adjudications.length)?'rejected':rows.every(r=>r.humanReview.status==='not_applicable')?'not_applicable':humanRequested?(rows.every(r=>['recorded','not_applicable'].includes(r.humanReview.status))?'recorded':'pending'):'not_requested'},
      complete:selectedStability.complete,score:humanRequested?finalScore:autoScore,
      caseScore:humanRequested?finalScore:autoScore,finalScore:humanRequested?finalScore:null,
      stability:{...selectedStability,interpretation:stability.expectedTrials===1?'single_trial_only':'repeated_trials',notProbabilityEstimate:true},trials:rows};
  });
    const groups=[...new Set(cases.map(c=>c.taskGroup))].map(taskGroup=>{
    const rows=cases.filter(c=>c.taskGroup===taskGroup),scores=rows.map(c=>c.score);
    return {taskGroup,caseCount:rows.length,automaticAverageScore:rows.every(r=>r.automatic.complete)?rows.reduce((s,r)=>s+r.automatic.score!,0)/rows.length:null,
      averageScore:scores.every(s=>s!==null)?scores.reduce<number>((s,v)=>s+v!,0)/scores.length:null,caseIds:rows.map(c=>c.caseId)};
  });
  const complete=cases.every(c=>c.complete),scores=cases.map(c=>c.score);
  const report={schemaVersion:'cwatch.detailed-eval-report.v3',evaluationMode,scoreScope:evaluationMode,humanReview:{requested:humanRequested,status:humanRequested?'case_assigned':'not_requested'},generatedAt:new Date().toISOString(),timezone:'Asia/Shanghai',batchId:raw.batchId,
    startedAt:raw.startedAt,endedAt:raw.endedAt,sourceVersion:raw.version,
    overview:{caseCount:cases.length,executionCount:trials.length,completedCases:cases.filter(c=>c.complete).length,pendingCases:cases.filter(c=>!c.complete).length,
      automaticCompletedCases:cases.filter(c=>c.automatic.complete).length,
      automaticPassRate:cases.every(c=>c.automatic.complete)?cases.filter(c=>c.automatic.passed).length/cases.length:null,
      automaticAverageScore:cases.every(c=>c.automatic.complete)?cases.reduce((s,c)=>s+c.automatic.score!,0)/cases.length:null,
      passRate:complete?cases.filter(c=>c.score!==null&&c.score>=80).length/cases.length:null,
      averageScore:complete?scores.reduce<number>((s,v)=>s+v!,0)/scores.length:null,
      models:trials.map(t=>t.model),totalAgentTokens:sumKnown(trials.map(t=>t.totalTokens)),totalJudgeTokens:sumKnown(trials.map(t=>t.judgeTokens)),
      totalTokens:sumKnown([sumKnown(trials.map(t=>t.totalTokens)),sumKnown(trials.map(t=>t.judgeTokens))]),
      knownAgentTokens:trials.reduce((s,t)=>s+(t.totalTokens??0),0),totalCost:sumKnown(trials.map(t=>t.actualCost)),actualCostIncludesJudge:false},
    groups,cases,automaticRegression:null as ReturnType<typeof assessRegressionBatch>|null,archive:{directory:batch,sourceReport:reportFile,gitCommitRequired:false,baselineConfirmed:cases.every(c=>c.baseline.status==='confirmed')},
    limits:[humanRequested?'本报告包含 Case 指定的人工审核，缺失时完整综合分待确认。':'本报告按自动范围计分，本轮不安排人工审核；历史人工记录独立保留，不计为新待办。','自动评分不代表人工确认或完整发布审核。','模型费用无可信计价时保留 null，不以 0 代替。','单次执行仅记录 pass^1，不证明重复稳定性。','连接错误记录为执行失败，但不能据此推断模型完成任务的能力。']};
  if(options.regression)report.automaticRegression=assessRegressionBatch(report);
  const file=join(batch,'test-report-'+randomUUID()+'.json'),markdown=file.replace(/\.json$/,'.md');
  writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const modelName=(model:unknown)=>model&&typeof model==='object'?`${(model as {provider?:string}).provider??'?'} / ${(model as {id?:string}).id??'?'}`:show(model);
  const scoreLabel=humanRequested?'人工综合分':'本次自动得分';
  const lines=['# Case 测试报告','',`生成时间：${new Date(report.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（Asia/Shanghai）`,
    `评测模式：${humanRequested?'人工审核':'自动评测'}；评分范围：${humanRequested?'代码、Rubric 与 Case 指定人工审核':'代码与 Rubric；本轮不安排人工审核'}。`,
    '', '## 全局概览','',`批次：${raw.batchId}；用例 ${cases.length}；执行 ${trials.length} 次；本模式评分完成 ${report.overview.completedCases}；待完成 ${report.overview.pendingCases}。`,
    `自动项通过率（≥80 且必过项满足）：${show(report.overview.automaticPassRate)}；自动项平均分：${show(report.overview.automaticAverageScore)}。自动项不包含人工确认。`,
    `通过率（${scoreLabel} ≥80）：${show(report.overview.passRate)}；平均分：${show(report.overview.averageScore)}。`,
    ...(report.automaticRegression?[`严格自动回归门禁：${report.automaticRegression.passed?'PASS':'FAIL'}；每例五次均须 100 分、代码和 Rubric 全通过、基线已确认。此门禁不代替人工评分。`]:[]),
    `执行模型：${[...new Set(trials.map(t=>modelName(t.model)))].join('；')}。`,
    `总 Token：${show(report.overview.totalTokens)}（Agent：${show(report.overview.totalAgentTokens)}；Judge：${show(report.overview.totalJudgeTokens)}）；总费用：未知（未记录可信定价，不填零）。`,
    '', '## 用例列表','', `| 任务分组 | 用例数 | 自动均分 | ${scoreLabel}均值 |`,'|---|---:|---:|---:|',...groups.map(g=>`| ${cell(g.taskGroup)} | ${g.caseCount} | ${cell(g.automaticAverageScore)} | ${cell(g.averageScore)} |`),
    '', `| 用例 | 名称 | 模型 | 执行次数 | 自动项得分 | 完整性 | ${scoreLabel} |`,'|---|---|---|---:|---:|---|---:|',...cases.map(c=>`| ${c.caseId} | ${cell(c.title)} | ${cell(modelName(c.models[0]))} | ${c.executionCount} | ${cell(c.automatic.score)} | ${c.complete?'已完成':'证据不完整或本模式评审未完成'} | ${cell(c.score)} |`)];
  for(const c of cases){
    const b=c.baseline;
    const regressionRow=report.automaticRegression?.cases.find(row=>row.caseId===c.caseId);
    const baselineText=b.status==='not_established'?'基线：尚未建立。':
      b.status==='candidate'||b.status==='confirmed'?`基线：${b.status==='confirmed'?'已人工确认':'候选，待人工确认过程及最终结果'}；runId：${b.runId}；耗时 ${show(b.durationMs)} ms；Token ${show(b.totalTokens)}；费用 ${show(b.actualCost)}；步骤数 ${show(b.steps)}；工具调用 ${show(b.toolCalls)}。 [冻结快照](${b.reference})`:
      `基线：${b.status==='incompatible'?'与当前 Case 不兼容':'校验失败'}；${b.reason}。`;
    lines.push('',`## 单例详情：${c.caseId}`,'',`任务分组：${c.taskGroup}；模型：${modelName(c.models[0])}。`,
      baselineText,'', '### Prompt','', '```text', c.trials[0].prompt??'未取得输入','```',
      '', '### 用例汇总','',`Agent Token 总开销：${show(c.totalTokens)}；Judge Token：${show(c.judgeTokens)}；总费用：${show(c.totalCost)}；平均费用：${show(c.averageCost)}；自动项得分：${show(c.automatic.score)}；${scoreLabel}：${show(c.score)}。`,
      '', '### 稳定性','',`计划 N=${c.stability.expectedTrials}；记录 ${c.executionCount} 次；完成全部评审：${c.complete?'是':'否'}；全部达标：${c.stability.allTrialsPassed?'是':'尚未确认或未达标'}。`,
      c.stability.expectedTrials===1?'本次为首次单次执行，尚不能据此认定重复稳定性。':'仅全部计划执行达标时取平均，否则用例分为 0；数据不完整时最终分待确认。',
      ...(regressionRow?[`严格自动稳定性：${regressionRow.passed?'PASS':'FAIL'}；通过 ${regressionRow.passedTrials}/5；已知失败 ${regressionRow.failedTrials}；待判 ${regressionRow.pendingTrials}；自动回归得分 ${show(regressionRow.score)}。完整人工评分状态单独保留。`]:[]),
      '', '### 执行记录','', `| Trial | runId | 执行状态 | Token | Judge Token | 费用 | 耗时 ms | 工具执行数 | 自动项得分 | ${scoreLabel} | 评分完整 |`, '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
      ...c.trials.map(t=>`| ${t.attempt} | ${cell(t.runId)} | ${cell(t.runStatus)} | ${cell(t.totalTokens)} | ${cell(t.judgeTokens)} | ${cell(t.actualCost)} | ${cell(t.durationMs)} | ${cell(t.toolCalls)} | ${cell(t.automatic?.score)} | ${cell(t.score)} | ${t.complete?'是':'否'} |`));
    for(const t of c.trials){
      lines.push('',`### Trial ${t.attempt} 证据与扣分`,'',t.trace?`[结构化 Trace](${t.trace})`:'结构化 Trace 未取得',t.traceEvents?`[原始 Trace](${t.traceEvents})`:'原始 Trace 未取得',
        '', humanRequested?'本模式包含指定人工审核，以下保留自动项判定。':'本轮不安排人工审核，按代码和 Rubric 汇总自动结果。',
        '', '| 维度 | 代码 | LLM | 自动扣分 | 人工状态 |','|---|---|---|---:|---|',
        ...(t.automatic?.dimensions??[]).map(d=>`| ${d.name} | ${d.code} | ${d.llm} | ${d.veto?'否决，合并扣100':cell(d.deduction)} | ${d.human} |`),
        '',`自动项得分：${show(t.automatic?.score)}；自动判定：${show(t.automatic?.verdict)}。过程自动扣分：${show(t.automatic?.processDeduction)}；耗时扣分：${show(t.automatic?.efficiencyDeduction)}；结果扣分：${show(t.automatic?.resultDeduction)}。`,
        '', '| 检查 | 维度 | 判定 | 说明 |','|---|---|---|---|',...t.codeChecks.map(check=>`| ${cell(check.criterionId)} | ${check.dimension} | ${check.outcome} | ${cell(check.reason)} |`),
        '', '| 扣分项 | 维度 | 分值 | 依据 |','|---|---|---:|---|',...t.deductions.map(d=>`| ${cell(d.group)} | ${d.dimensions.join(', ')} | ${d.points} | ${cell(d.reason)} |`),
        ...(t.deductions.length?[]:[`| 无已确认扣分 | — | — | ${t.complete?'本模式评分已完成':'证据不足不等于满分'} |`]),
        '',`待确认项：${t.unknownCheckIds.join('、')||'无'}。`,
        '',`LLM Judge：${t.judge?`${t.judge.status} / ${t.judge.verdict}`:'未完成'}；人工审核：${t.humanReview.status==='rejected'?'已人工否决':t.humanReview.status==='not_applicable'?'不适用':humanRequested?(t.human?`${t.human.status} / ${t.human.verdict}`:'未完成'):(t.human?'本轮不安排，已有历史记录保留':'本轮不安排')}。`,
        '', '#### 实际回答','', typeof t.answer==='string'?t.answer.split('\n').map(line=>'> '+line).join('\n'):'未取得回答。',
        '',`执行失败项：${t.failures.join('、')||'无'}。`);
      if(t.judge?.answer)lines.push('', '#### LLM 逐项判定','', '| 条目 | 判定 | 理由 | 证据 |','|---|---|---|---|',
        ...t.judge.answer.findings.map(f=>`| ${cell(f.criterionId)} | ${f.verdict} | ${cell(f.reason)} | ${cell(f.evidence.join(', '))} |`));
      if(t.judge?.error)lines.push('',`Judge 错误：${t.judge.error}`);
      if(t.adjudications.length)lines.push('', '#### 人工条目裁决','',
        '人工已确认条目失败，结果否决扣 100，单次得分为 0。原 Judge 自动评分保留；其余未评项不自动批准。','',
        '| 条目 | 人工判定 | 理由 | 用户原话 | 记录 |','|---|---|---|---|---|',
        ...t.adjudications.flatMap(r=>r.input.findings.map(f=>`| ${cell(f.criterionId)} | fail | ${cell(f.reason)} | ${cell(r.input.userStatement)} | [人工裁决](human-adjudications/${r.id}/record.json) |`)));
    }
  }
  lines.push('', '## 归档','',`本批次目录：${batch}`, '归档不需要 Git 提交。原始记录与失败结果保留，不自动确认基线。', '', ...report.limits.map(s=>'- '+s));
  writeFileSync(markdown,lines.join('\n')+'\n',{flag:'wx'});
  return{json:file,markdown,overview:report.overview,evaluationMode,automaticPassed:cases.every(c=>c.automatic.passed),automaticFailed:trials.some(t=>t.automatic?.verdict==='fail'||t.runStatus==='failed'||t.runStatus==='cancelled'),finalPassed:humanRequested&&quality.metrics.releaseGate,regression:report.automaticRegression};
}
