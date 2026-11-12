import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from './evaluation/langfuse-client.ts';
import { prepareLangfuseEvaluation, syncLangfuseEvaluation } from './evaluation/langfuse-eval.ts';
import { ReviewPending, type NativeSlot } from './evaluation/langfuse-review.ts';
import { ensureDimensionJudges, retireScenarioJudges, EvalScenarioSchema } from './evaluation/langfuse-judges.ts';
import { syncLangfuseAssets, applyRegisteredJudgePrompts, pullLangfuseSuite } from './evaluation/langfuse-assets.ts';
import { evaluationAssets } from './evaluation/langfuse-suite.ts';

if(existsSync('.env'))process.loadEnvFile('.env');
const redactor=new Redactor(Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''));
try{
  const {values}=parseArgs({options:{mode:{type:'string',default:'prepare'},report:{type:'string'},case:{type:'string'},attempt:{type:'string'},binding:{type:'string'},
    'adopt-pilot':{type:'string'},native:{type:'boolean'},scenario:{type:'string'},'update-prompts':{type:'boolean'},'apply-registered-prompts':{type:'boolean'},'retire-scenario-judges':{type:'boolean'},'archive-input-templates':{type:'boolean'},'dry-run':{type:'boolean'},adjudication:{type:'boolean'},'no-human':{type:'boolean'},watch:{type:'boolean'},'watch-minutes':{type:'string',default:'60'},help:{type:'boolean'}}});
  if(values.help)console.log([
    'eval:langfuse -- --mode assets [--dry-run] [--update-prompts] [--archive-input-templates]',
    'eval:langfuse -- --mode pull (export ACTIVE platform Cases for the existing eval runner)',
    'eval:langfuse -- --mode judges [--update-prompts | --apply-registered-prompts] [--retire-scenario-judges]',
    'eval:langfuse -- --report <batch/report.json> --case <ID> [--attempt 1] [--native] [--scenario activation|core_logic|resilience|artifact_quality] [--no-human]',
    'eval:langfuse -- --mode sync --binding <binding.json> [--watch] [--watch-minutes 60]',
    'Assets uploads four Datasets with 14 complete review-candidate Cases and only 3 Judge templates, without scoring. Registered Judge templates use the evaluation label; explicit --apply-registered-prompts deploys them to the same Evaluator IDs.',
    'Three stable result/process/evidence Judges share the configured model; four case scenarios provide context only. Normal prepares preserve Evaluator UI edits; --update-prompts explicitly replaces them from evals/judges. Native findings use the frozen Case rubric and independent evidence audit. No global automatic rule is created.',
  ].join('\n'));
  else if(values['dry-run']){
    if(values.mode!=='assets')throw Error('dry_run_requires_assets_mode');
    console.log(JSON.stringify(evaluationAssets().map(item=>({caseId:item.caseId,revision:item.revision,dataset:item.datasetName,judges:item.metadata.judgeDimensions,human:item.metadata.humanDimensions,rubricStatus:item.metadata.rubricStatus})),null,2));
  }else{
    const config=readLangfuseConfig();if(!config)throw Error('langfuse_config_missing');
    const client=new LangfuseClient(config,fetch,redactor);
    if(values['archive-input-templates']&&values.mode!=='assets')throw Error('archive_input_templates_requires_assets_mode');
    if(values['apply-registered-prompts']&&(values.mode!=='judges'||values['update-prompts']))throw Error('apply_registered_prompts_requires_judges_mode_without_update_prompts');
    if(values['update-prompts']&&!['judges','assets'].includes(values.mode!))throw Error('update_prompts_requires_judges_or_assets_mode');
    if(values['retire-scenario-judges']&&values.mode!=='judges')throw Error('retire_scenario_judges_requires_judges_mode');
    if(values.mode==='assets'){
      if(values.report||values.case||values.binding||values.native||values.scenario||values.watch||values['adopt-pilot'])throw Error('assets_mode_does_not_take_a_case_or_run');
      const catalog=await syncLangfuseAssets(client,{updatePrompts:values['update-prompts'],archiveInputTemplates:values['archive-input-templates']});
      mkdirSync('.runtime/langfuse-assets',{recursive:true});writeFileSync('.runtime/langfuse-assets/catalog.json',JSON.stringify(catalog,null,2)+'\n');
      console.log(JSON.stringify(catalog,null,2));
    }else if(values.mode==='pull'){
      if(values.report||values.case||values.binding||values.native||values.scenario||values.watch||values['adopt-pilot'])throw Error('pull_mode_does_not_take_a_run');
      console.log(JSON.stringify(await pullLangfuseSuite(client),null,2));
    }else if(values.mode==='judges'){
      if(values.report||values.case||values.binding||values.native||values.scenario||values.watch||values['adopt-pilot'])throw Error('judges_mode_does_not_take_a_case_or_run');
      const applied=values['apply-registered-prompts']?await applyRegisteredJudgePrompts(client):undefined;
      const judges=await ensureDimensionJudges(client,{updatePrompts:values['update-prompts']}),projectId=await client.projectId();
      const retired=values['retire-scenario-judges']?await retireScenarioJudges(client):[];
      const catalog={schemaVersion:'cwatch.langfuse-dimension-judges.v1',baseUrl:config.baseUrl,projectId,judges,retired,applied,evaluatorsUrl:config.baseUrl+'/project/'+projectId+'/evals'};
      mkdirSync('.runtime/langfuse-judges',{recursive:true});writeFileSync('.runtime/langfuse-judges/catalog.json',JSON.stringify(catalog,null,2)+'\n');
      console.log(JSON.stringify(catalog,null,2));
    }else if(values.mode==='prepare'){
      if(!values.report||!values.case||values.binding||values.watch)throw Error('prepare_requires_report_and_case');
      let adopt:{traceId:string;observationId:string;native:NativeSlot[]}|undefined;
      if(values['adopt-pilot']){
        const pilot=z.object({report:z.string(),caseId:z.string(),traceId:z.string(),observationId:z.string(),evaluators:z.array(z.object({id:z.string(),name:z.string(),versionId:z.string()}))}).parse(JSON.parse(readFileSync(values['adopt-pilot'],'utf8')));
        if(realpathSync(pilot.report)!==realpathSync(values.report)||pilot.caseId!==values.case)throw Error('pilot_subject_mismatch');
        adopt={traceId:pilot.traceId,observationId:pilot.observationId,native:pilot.evaluators.map(e=>({criterionId:e.name.endsWith('-audit')?e.name.slice(0,-6):e.name,evaluatorId:e.id,versionId:e.versionId,name:e.name,role:e.name.endsWith('-audit')?'evidence_audit':'primary'}))};
      }
      console.log(JSON.stringify(await prepareLangfuseEvaluation(client,{report:values.report,caseId:values.case,attempt:values.attempt?Number(values.attempt):1,queueHuman:!values['no-human'],adjudication:values.adjudication,native:values.native,scenario:values.scenario?EvalScenarioSchema.parse(values.scenario):undefined,adopt}),null,2));
    }else if(values.mode==='sync'){
      if(!values.binding||values.report||values.case||values['adopt-pilot']||values.native||values.scenario)throw Error('sync_requires_binding_only');
      const minutes=Number(values['watch-minutes']);if(!Number.isFinite(minutes)||minutes<1||minutes>1440)throw Error('watch_minutes_must_be_1_to_1440');
      const until=Date.now()+minutes*60000;let previous='';
      do{
        const result=await syncLangfuseEvaluation(client,values.binding),fingerprint=JSON.stringify({version:result.version,status:result.status,pending:result.pending});
        if(fingerprint!==previous){console.log(JSON.stringify(result));previous=fingerprint;}
        if(result.status==='completed'){process.exitCode=result.final.passed?0:1;break;}
        process.exitCode=2;if(!values.watch||Date.now()>=until)break;
        await new Promise(resolve=>setTimeout(resolve,10000));
      }while(Date.now()<until);
    }else throw Error('mode_must_be_prepare_sync_judges_assets_or_pull');
  }
}catch(error){console.error(redactor.clean(error instanceof Error?error.message:'langfuse_evaluation_failed'));process.exitCode=error instanceof ReviewPending?2:3;}
