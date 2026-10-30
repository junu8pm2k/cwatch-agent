import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { saveDetailedEvaluationReport } from './evaluation/report.ts';
const {values}=parseArgs({options:{report:{type:'string'},mode:{type:'string',default:'automatic'}}});
try{if(!values.report)throw Error('provide --report <batch/report.json>');if(!['automatic','human_review'].includes(values.mode!))throw Error('mode must be automatic or human_review');console.log(JSON.stringify(saveDetailedEvaluationReport(resolve(values.report),{evaluationMode:values.mode as 'automatic'|'human_review'})));}
catch(error){console.error(error instanceof Error?error.message:'detailed_report_failed');process.exitCode=1;}
