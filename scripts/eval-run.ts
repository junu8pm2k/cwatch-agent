import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { runEvaluationPipeline, HumanReviewRequired } from './evaluation/pipeline.ts';
if(existsSync('.env'))process.loadEnvFile('.env');
const redactor=new Redactor(Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''));
try{
  const {values}=parseArgs({options:{dataset:{type:'string'},report:{type:'string'},case:{type:'string'},repeat:{type:'string'},out:{type:'string'},gate:{type:'string',default:'automatic'},replay:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help)console.log('eval:run -- --dataset <dataset.json> [--case ID] [--repeat 1] [--gate automatic|final|regression]\neval:run -- --report <existing-batch/report.json> [--gate automatic|final|regression]\nDefault automatic and regression modes never queue human work. Explicit --gate final stops for required human review BEFORE generating a final report or ZIP; import the response and resume --report. Regression requires five unique complete 100-point trials, all code/Rubric checks and a confirmed baseline. Generates a scoped six-level report and ZIP. --report reuses matching completed Judge records. Exit 0=selected gate passed, 1=failed, 2=pending, 3=pipeline/configuration error.');
  else{
    if(!['automatic','final','regression'].includes(values.gate!))throw Error('gate must be automatic, final or regression');
    if(values.report&&(values.case||values.repeat||values.out||values.replay))throw Error('--report resumes the complete frozen batch; execution options cannot change it');
    const controller=new AbortController(),cancel=()=>controller.abort(Error('evaluation_cancelled'));process.once('SIGINT',cancel);
    try{
      const result=await runEvaluationPipeline({dataset:values.dataset,report:values.report,caseId:values.case,repeat:values.repeat?Number(values.repeat):undefined,
        out:values.out,gate:values.gate as 'automatic'|'final'|'regression',realModel:!values.replay,signal:controller.signal,onEvent:event=>console.log(JSON.stringify(event))});
      console.log(JSON.stringify({pipeline:result.resultPath,report:result.report.markdown,structuredReport:result.report.json,archive:result.archive.path,
        automaticPassed:result.automaticPassed,finalPassed:result.finalPassed,pendingHuman:result.humanInputs.length,exitCode:result.exitCode}));process.exitCode=result.exitCode;
    }finally{process.removeListener('SIGINT',cancel);}
  }
}catch(error){
  if(error instanceof HumanReviewRequired){
    console.log(JSON.stringify({status:'awaiting_human',checkpoint:error.checkpoint.checkpointPath,sourceReport:error.checkpoint.sourceReport,
      report:null,archive:null,pendingHuman:error.checkpoint.humanInputs.length,
      reviews:error.checkpoint.reviews.map(({prompt,answer,...files})=>files),message:error.checkpoint.message,exitCode:2}));process.exitCode=2;
  }else{console.error(redactor.clean(error instanceof Error?error.message:'evaluation_pipeline_failed'));process.exitCode=3;}
}
