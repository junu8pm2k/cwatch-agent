import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { runBatch, compareReports } from './evaluation/runner.ts';
import { loadDataset } from './evaluation/dataset.ts';
import { AGENT_TYPES, type AgentType } from './evaluation/penalty.ts';

const {values}=parseArgs({options:{dataset:{type:'string'},out:{type:'string'},case:{type:'string'},repeat:{type:'string'},lint:{type:'boolean'},'require-approved':{type:'boolean'},compare:{type:'string'},'real-model':{type:'boolean'},split:{type:'string'},'agent-type':{type:'string'},'score-gate':{type:'boolean'}}});
try{
  if(values.split&&!['regression','holdout'].includes(values.split))throw Error('split_must_be_regression_or_holdout');
  if(values['agent-type']&&!AGENT_TYPES.includes(values['agent-type'] as AgentType))throw Error('agent_type_must_be_'+AGENT_TYPES.join('|'));
  if(values.lint){const data=loadDataset(values.dataset??(values['real-model']?'evals/model-diagnostic/dataset.json':'evals/regression/dataset.json'));console.log(JSON.stringify({dataset:data.manifest.id,cases:data.entries.length,approved:data.entries.filter(c=>c.value.status==='approved').length,gate:'PASS'}));}
  else{
    const controller=new AbortController();process.once('SIGINT',()=>controller.abort(new Error('user_cancelled')));
    const {report,path,gate}=await runBatch({dataset:values.dataset??(values['real-model']?'evals/model-diagnostic/dataset.json':undefined),out:values.out,caseId:values.case,repeat:values.repeat?Number(values.repeat):1,requireApproved:values['require-approved'],signal:controller.signal,realModel:values['real-model'],split:values.split as 'regression'|'holdout'|undefined,agentType:values['agent-type'] as AgentType|undefined,scoreGate:values['score-gate']});
    console.log(JSON.stringify({report:path,metrics:values.split==='holdout'?{planned:report.metrics.planned,pass:report.metrics.pass,fail:report.metrics.fail,needsReview:report.metrics.needs_review,invalid:report.metrics.invalid,releaseGate:report.metrics.releaseGate}:report.metrics}));
    if(values.compare)console.log(JSON.stringify(compareReports(JSON.parse(readFileSync(values.compare,'utf8')),report)));
    if(!gate)process.exitCode=1;
  }
}catch(error){console.error(error instanceof Error?error.message:'evaluation_failed');process.exitCode=1;}
