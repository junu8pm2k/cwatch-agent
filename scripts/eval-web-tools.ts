import '../tests/web.test.ts';
import '../tests/web-mcp.test.ts';
import '../tests/web-api.test.ts';
import { cases } from '../tests/harness.ts';

let passed = 0;
for (const entry of cases) {
  try { await entry.run(); passed++; }
  catch (error) { console.error('FAIL ' + entry.name, error); }
}
console.log(JSON.stringify({ suite: 'web-tools', passed, total: cases.length }));
if (passed !== cases.length) process.exitCode = 1;
