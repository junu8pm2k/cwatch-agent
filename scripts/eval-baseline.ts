import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { approveBaseline, prepareBaseline } from './evaluation/baseline.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key) && value).map(([, value]) => value!);
const redactor = new Redactor(secrets);
try {
  const { values } = parseArgs({ options: { report: { type: 'string' }, case: { type: 'string' }, attempt: { type: 'string' },
    binding: { type: 'string' }, input: { type: 'string' }, approve: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log('eval:baseline -- --report <batch/report.json> --case ID [--attempt 1]\nFreeze a passing run as a version-controlled candidate; no model requests or human approval are invented.\neval:baseline -- --binding <evals/baselines/ID.rN.json> --approve --input <human-approval.json>\nConfirmation requires actual human acceptance of both the observable process and final result.');
  else if (values.approve) {
    if (!values.binding || !values.input || values.report || values.case || values.attempt) throw Error('provide --binding and --input with --approve');
    console.log(JSON.stringify(approveBaseline(values.binding, JSON.parse(readFileSync(values.input, 'utf8'))), null, 2));
  } else {
    if (!values.report || !values.case || values.binding || values.input) throw Error('provide --report and --case to prepare a baseline candidate');
    console.log(JSON.stringify(prepareBaseline({ report: values.report, caseId: values.case, attempt: values.attempt ? Number(values.attempt) : 1, secrets }), null, 2));
  }
} catch (error) { console.error(redactor.clean(error instanceof Error ? error.message : 'baseline_failed')); process.exitCode = 1; }
