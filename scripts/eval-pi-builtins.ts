import '../tests/pi-builtins.test.ts';
import { cases } from '../tests/harness.ts';

let passed = 0;
for (const entry of cases) {
  try { await entry.run(); passed++; console.log('PASS ' + entry.name); }
  catch (error) { console.error('FAIL ' + entry.name, error); }
}
console.log(JSON.stringify({ suite: 'pi-builtins', passed, total: cases.length }));
if (passed !== cases.length) process.exitCode = 1;
