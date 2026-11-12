import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { InputSchema } from './evaluation/contracts.ts';
import { executeScenario } from './evaluation/scenarios.ts';
import { BaselineTrialSchema, publishBaselineTrial, sealPromptOnlyTrial, syncBaselineTrial } from './evaluation/langfuse-trial.ts';
import { jsonHash } from './evaluation/quality.ts';
import { readModelConfig } from '@cwatch/shared/config/models';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from './evaluation/langfuse-client.ts';
import { ReviewPending } from './evaluation/langfuse-review.ts';

if(existsSync('.env'))process.loadEnvFile('.env');
const redactor=new Redactor(Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''));
try{
  const {values}=parseArgs({options:{input:{type:'string'},case:{type:'string'},revision:{type:'string'},trial:{type:'string'},sync:{type:'boolean'},publish:{type:'boolean'},watch:{type:'boolean'},'watch-minutes':{type:'string',default:'60'},help:{type:'boolean'}}});
  if(values.help)console.log('eval:baseline:trial -- --input <prompt-only.input.json> --case <ID> --revision <N> [--publish]\neval:baseline:trial -- --trial <trial.json> --publish|--sync\nRuns once without a rubric, expected answer or Judge. Preserves original evidence; never confirms a baseline on behalf of the user.');
  else{
    const config=readLangfuseConfig(),client=config?new LangfuseClient(config,fetch,redactor):undefined;
    if((values.publish||values.sync)&&!client)throw Error('langfuse_config_missing');
    if(values.trial){
      if(values.input||values.case||values.revision||Boolean(values.publish)===Boolean(values.sync))throw Error('choose_publish_or_sync_for_existing_trial');
      if(values.watch&&!values.sync)throw Error('watch_requires_sync');
      const minutes=Number(values['watch-minutes']);if(!Number.isFinite(minutes)||minutes<1||minutes>1440)throw Error('watch_minutes_must_be_1_to_1440');
      let previous='';const until=Date.now()+minutes*60000;
      do{
        let result;
        try{result=values.sync?await syncBaselineTrial(client!,values.trial):await publishBaselineTrial(client!,values.trial);}
        catch(error){if(!(error instanceof ReviewPending))throw error;result={status:'needs_review',message:error.message,baselineConfirmed:false};}
        const encoded=JSON.stringify(result);if(encoded!==previous){console.log(encoded);previous=encoded;}
        const status='status' in result?result.status:undefined;
        if(status==='human_accepted'||status==='rejected'){process.exitCode=status==='human_accepted'?0:1;break;}
        if(!values.watch){if(status==='awaiting_human'||status==='needs_review')process.exitCode=2;break;}
        process.exitCode=2;await new Promise(resolve=>setTimeout(resolve,10000));
      }while(Date.now()<until);
    }else{
      if(!values.input||!values.case||!values.revision||values.sync||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(values.case))throw Error('provide_prompt_only_input_case_and_revision');
      const input=InputSchema.parse(JSON.parse(readFileSync(values.input,'utf8')));
      if(input.scenario.driver!=='runtime'||input.scenario.modelMode!=='pi_session'||input.scenario.steps.length)throw Error('baseline_trial_requires_real_unscripted_runtime');
      const trial=BaselineTrialSchema.parse({schemaVersion:'cwatch.prompt-only-trial.v1',id:randomUUID(),caseId:values.case,caseRevision:Number(values.revision),createdAt:new Date().toISOString(),
        inputSha256:jsonHash(input),reviewStatus:'awaiting_user_review',baselineConfirmed:false,expectations:null,rubric:null,judge:null});
      const directory=resolve('artifacts/baseline-trials',values.case,'r'+trial.caseRevision,trial.id);mkdirSync(directory,{recursive:true});
      const save=(name:string,value:unknown)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
      save('input.json',input);save('trial.json',trial);writeFileSync(join(directory,'prompt.md'),input.scenario.instruction,{flag:'wx'});
      console.log(JSON.stringify({status:'running',trial:join(directory,'trial.json'),judge:null}));
      try{
        const observed=await executeScenario(input,directory,readModelConfig());sealPromptOnlyTrial(directory,observed);
        console.log(JSON.stringify({status:observed.status,runId:observed.runId,trial:join(directory,'trial.json'),outcome:join(directory,'outcome.md'),usage:observed.usage,baselineConfirmed:false}));
        if(observed.status!=='complete')process.exitCode=1;
        if(values.publish)console.log(JSON.stringify(await publishBaselineTrial(client!,join(directory,'trial.json')),null,2));
      }catch(error){save('trial-error.json',redactor.clean({error:String(error)}));throw error;}
    }
  }
}catch(error){console.error(redactor.clean(error instanceof Error?error.message:'baseline_trial_failed'));process.exitCode=error instanceof ReviewPending?2:3;}
