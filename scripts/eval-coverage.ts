import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { coverageInventory, coverageMarkdown } from './evaluation/coverage.ts';
import { within } from './evaluation/dataset.ts';
try{
  const {values}=parseArgs({options:{index:{type:'string'}}});
  if(!values.index)throw Error('evaluation_index_required: bundled eval cases have been removed; provide --index <file>');
  const report=coverageInventory(values.index),root=resolve('artifacts/coverage');mkdirSync(root,{recursive:true});
  if(!within(realpathSync(process.cwd()),realpathSync(root)))throw Error('coverage_output_escape');
  writeFileSync(resolve(root,'latest.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(resolve(root,'latest.md'),coverageMarkdown(report));
  console.log(JSON.stringify({path:resolve(root,'latest.md'),kind:report.kind,totalCases:report.totalCases,matrix:report.matrix}));
}catch(error){console.error(error instanceof Error?error.message:'coverage_failed');process.exitCode=1;}
