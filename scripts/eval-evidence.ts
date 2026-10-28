import { parseArgs } from 'node:util';
import { regradeArchivedCase, collectFailureCandidate } from './evaluation/operations.ts';
const {values}=parseArgs({options:{report:{type:'string'},case:{type:'string'},attempt:{type:'string'},collect:{type:'boolean'}}});
try{
  if(!values.report||!values.case)throw Error('provide --report <batch/report.json> --case <caseId>');
  const attempt=values.attempt?Number(values.attempt):1;if(!Number.isInteger(attempt)||attempt<1)throw Error('invalid_attempt');
  const result=values.collect?collectFailureCandidate(values.report,values.case,process.cwd(),attempt):regradeArchivedCase(values.report,values.case,attempt);
  console.log(JSON.stringify(result));
}catch(error){console.error(error instanceof Error?error.message:'evidence_operation_failed');process.exitCode=1;}
