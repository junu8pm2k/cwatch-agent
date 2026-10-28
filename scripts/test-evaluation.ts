import '../tests/evaluation.test.ts';
import '../tests/evaluation-review.test.ts';
import '../tests/evaluation-quality.test.ts';
import '../tests/evaluation-scenarios.test.ts';
import '../tests/evaluation-penalty.test.ts';
import '../tests/structured-trace.test.ts';
import { cases } from '../tests/harness.ts';
let passed=0;
for(const c of cases){try{await c.run();passed++;console.log('PASS '+c.name);}catch(error){console.error('FAIL '+c.name,error);}}
console.log(JSON.stringify({suite:'evaluation',passed,total:cases.length}));if(passed!==cases.length)process.exitCode=1;
