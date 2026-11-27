import { createServer } from 'node:http';
import { once } from 'node:events';
import type { CompetitorTask, Decision } from '@cwatch/core/types';
import { investigationDecisions, resolveInvestigationDecision } from './tracked-investigation-fixture.ts';

/** Real Chat Completions/SSE protocol fixture. It performs no external model request. */
export async function startWorkbenchProvider(){
  let cursor=0,steps:Decision[]=[];const errors:string[]=[];
  const modelRequests:Array<{model:string;reasoningEffort?:string}>=[];let initialTask:CompetitorTask|undefined;
  const server=createServer(async(req,res)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      modelRequests.push({model:request.model,reasoningEffort:request.reasoning_effort});
      const text=request.messages.filter((m:{role:string})=>m.role==='user').map((m:{content:unknown})=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map((item:{text?:string})=>item.text??'').join('\n'):'').join('\n');
      const memory = !request.tools?.length && text.startsWith('{"currentMemory":');
      if(!memory&&cursor===0){
        const match=/TASK CONSTRAINTS: (\{[^\n]+\})/.exec(text);if(!match)throw Error('missing_task_in_model_context');
        const task=JSON.parse(match[1]) as CompetitorTask;initialTask=task;
        steps=investigationDecisions(task);
      }
      const next: Decision | undefined = memory ? { kind: 'respond', text: JSON.stringify({ userGoal: '核对 Node.js 发布记录', completedWork: ['草稿已生成'], keyFiles: [], errorsAndFixes: [], unfinishedTasks: [], nextSteps: ['返回报告'], references: [], sourceGaps: [] }) } : structuredClone(steps[cursor++]);
      if(!next)throw Error('unexpected_model_turn');
      const step = resolveInvestigationDecision(next, Boolean(initialTask?.evidencePolicy), name => {
        const call = request.messages.flatMap((m:{tool_calls?:Array<{id:string;function:{name:string}}>})=>m.tool_calls??[]).find((item:{function:{name:string}})=>item.function.name===name);
        const observation = call && request.messages.find((m:{role:string;tool_call_id?:string})=>m.role==='tool'&&m.tool_call_id===call.id);
        return observation ? JSON.parse(observation.content) : undefined;
      });
      const calls=step.kind==='respond'?[]:step.kind==='call_tools'?step.calls:[step];
      const delta=step.kind==='respond'?{role:'assistant',content:step.text}:{role:'assistant',tool_calls:calls.map((call,index)=>({index,id:'sdkToolCallId' in call?call.sdkToolCallId:'web-sdk-call-'+cursor,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))};
      const chunk={id:'web-sdk-response-'+modelRequests.length,object:'chat.completion.chunk',created:1,model:'web-fixture-model',choices:[{index:0,delta,finish_reason:null}]};
      res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(chunk)+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:step.kind==='respond'?'stop':'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
    }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end('fixture provider failed');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('invalid_provider_address');
  return{url:'http://127.0.0.1:'+address.port+'/v1',errors,modelRequests,initialTask:()=>initialTask,turns:()=>cursor,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
