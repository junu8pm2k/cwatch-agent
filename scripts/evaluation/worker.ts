import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { executeScenario } from './scenarios.ts';

// The controller sends Input only. This worker never receives Case labels or a Judge.
const output=resolve(process.argv[2]),privateProbe=resolve(process.argv[3]);
const send=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
send({type:'started'});
try{
  let deniedRead=false,deniedSpawn=false;
  try{readFileSync(privateProbe);}catch(error){deniedRead=(error as NodeJS.ErrnoException).code==='ERR_ACCESS_DENIED';}
  try{const child=spawnSync(process.execPath,['-e','process.exit(0)']);deniedSpawn=child.error?.message.includes('Access to this API has been restricted')??false;}
  catch(error){deniedSpawn=(error as NodeJS.ErrnoException).code==='ERR_ACCESS_DENIED';}
  if(!deniedRead||!deniedSpawn)throw Error('eval_file_or_child_boundary_not_enforced');
  writeFileSync(resolve(output,'boundary.json'),JSON.stringify({privateReadDenied:deniedRead,childProcessDenied:deniedSpawn,networkIsolation:'not_os_verified',credentialEnvironment:'not_inherited'}));
  const chunks:Buffer[]=[];let length=0;for await(const chunk of process.stdin){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>1000000)throw Error('eval_input_too_large');chunks.push(bytes);}
  const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // SDK resource discovery must stay inside the granted input/output workspace.
  process.chdir(output);
  const observed=await executeScenario(envelope.input,output,envelope.credentials,envelope.agentPrompts);
  writeFileSync(resolve(output,'observed.json'),JSON.stringify(observed,null,2)+'\n');send({type:'finished',runId:observed.runId});
}catch(error){send({type:'harness_error',code:error instanceof Error?error.message:'worker_error'});process.exitCode=1;}
