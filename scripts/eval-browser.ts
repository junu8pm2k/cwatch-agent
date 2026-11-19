import '../tests/browser-live.test.ts';
import { cases } from '../tests/harness.ts';
import { browserVersions } from '../tests/browser-fixture.ts';
import { FileStore } from "@cwatch/shared/sessions/storage";
const startedAt=new Date().toISOString(),results:Array<{name:string;group:string;passed:boolean;durationMs:number;error?:string}>=[];
for(const item of cases){
  const started=Date.now();
  try{await item.run();results.push({name:item.name,group:item.group,passed:true,durationMs:Date.now()-started});console.log('PASS '+item.name);}
  catch(error){results.push({name:item.name,group:item.group,passed:false,durationMs:Date.now()-started,error:error instanceof Error?error.stack:String(error)});console.error('FAIL '+item.name+'\n'+String(error));}
}
const report={startedAt,endedAt:new Date().toISOString(),command:'npm run test:browser',dataset:'synthetic-browser-render-v1',dataProvenance:'fixture',engine:'real Playwright Chromium/Edge',browserVersions:[...new Set(browserVersions)],metrics:{total:results.length,passed:results.filter(r=>r.passed).length},releaseGate:results.every(r=>r.passed),results};
const store=new FileStore('artifacts/browser-eval');store.write('latest.json',report);
store.text('latest.md','# 浏览器后端验收\n\n'+report.startedAt+'\n\n通过 '+report.metrics.passed+'/'+report.metrics.total+'；门禁 '+(report.releaseGate?'PASS':'FAIL')+'\n\n实际浏览器版本：'+report.browserVersions.join(', ')+'\n\n数据均为本地路由的合成 fixture；证明浏览器执行、边界与取消，不是外部真实竞品或模型质量验收。\n\n'+results.map(r=>'- '+(r.passed?'PASS':'FAIL')+' '+r.name+(r.error?': '+r.error:'')).join('\n')+'\n');
console.log(JSON.stringify({metrics:report.metrics,releaseGate:report.releaseGate,browserVersions:report.browserVersions}));
if(!report.releaseGate)process.exitCode=1;
