import { readFileSync } from 'node:fs';
import type { RunService } from '@cwatch/server-core/runtime/run-service';
import { ReplayModel } from '@cwatch/shared/agent/models';
import type { ToolRegistry } from '@cwatch/shared/tools/registry';
import type { SourceClient } from '@cwatch/core/types';
import type { RunSnapshot } from '@cwatch/core/types/runs';
import { fixture } from './harness.ts';

export function waitForRun(service:RunService,runId:string,predicate:(run:RunSnapshot)=>boolean):Promise<RunSnapshot>{
  const current=service.get(runId);if(predicate(current))return Promise.resolve(current);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(Error('run_state_timeout:'+service.get(runId).status));},15000);const off=service.subscribe(runId,value=>{if(predicate(value)){clearTimeout(timer);off();resolve(value);}});});
}
export function approvalFixture(slug='official'){
  const calls:string[]=[],steps=JSON.parse(readFileSync('fixtures/model-script.json','utf8'));
  steps[0].args.sources=[slug];
  steps.splice(1,0,{kind:'call_tool',name:slug+'__request_publish',args:{message:'Synthetic publish fixture only'}});
  return {
    calls,modelFactory:(_mode:string,task:{taskId:string})=>{const cloned=structuredClone(steps);cloned[0].args.taskId=task.taskId;return new ReplayModel(cloned);},
    configureRegistry:async(registry:ToolRegistry,signal:AbortSignal)=>{
      const web=registry.binding('web_fetch');
      const client:SourceClient={
        listTools:async()=>[{name:'web_fetch',namespace:'native',description:'Fixture official page',action:'collect',inputSchema:web.inputSchema},{name:'request_publish',description:'Synthetic write approval test',action:'publish',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}}],
        callTool:async(name)=>{calls.push(name);if(name==='web_fetch'){const data=fixture();data.signals.forEach(s=>{s.sourceSlug=slug;});return data;}return{kind:'mcp_tool_result',status:'success',isError:false,sourceSlug:slug,tool:name,provenance:'fixture',raw:'{"ok":true}',result:{ok:true}};},close:async()=>{},
      };
      await registry.register(slug,'builtin',client,signal);
    },
  };
}
