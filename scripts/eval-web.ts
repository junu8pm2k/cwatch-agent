import '../tests/web-ui.test.ts';
import '../tests/web-ui-rail-trace.test.ts';
import { cases } from '../tests/harness.ts';
import { FileStore } from '@cwatch/shared/sessions/storage';
const startedAt=new Date().toISOString(),results:Array<{name:string;group:string;passed:boolean;durationMs:number;error?:string}>=[];
for(const item of cases){const started=Date.now();try{await item.run();results.push({name:item.name,group:item.group,passed:true,durationMs:Date.now()-started});console.log('PASS '+item.name);}catch(error){results.push({name:item.name,group:item.group,passed:false,durationMs:Date.now()-started,error:error instanceof Error?error.stack:String(error)});console.error('FAIL '+item.name+'\n'+String(error));}}
const report={startedAt,endedAt:new Date().toISOString(),command:'npm run test:web',dataset:'synthetic-workbench-ui-v1',dataProvenance:'fixture',engine:'real Edge/Chromium + real HTTP/SSE + host tool gate',metrics:{total:results.length,passed:results.filter(r=>r.passed).length},releaseGate:results.every(r=>r.passed),results};
const data=new FileStore('artifacts/web-eval');data.write('latest.json',report);data.text('latest.md','# Web 工作台验收\n\n'+startedAt+'\n\n通过 '+report.metrics.passed+'/'+report.metrics.total+'，门禁 '+(report.releaseGate?'PASS':'FAIL')+'\n\n真实浏览器、真实 HTTP/SSE、真实 RunService 与权限链；模型及业务页面为明确合成 fixture，不证明线上模型质量。\n\n'+results.map(r=>'- '+(r.passed?'PASS':'FAIL')+' '+r.name+(r.error?': '+r.error:'')).join('\n')+'\n');
console.log(JSON.stringify({metrics:report.metrics,releaseGate:report.releaseGate}));if(!report.releaseGate)process.exitCode=1;
