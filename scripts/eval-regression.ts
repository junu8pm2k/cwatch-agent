import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { checkRegressionSuite, qualifyRegressionCase, runRegressionSuite } from './evaluation/regression.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? ''));
try {
  const { values } = parseArgs({ options: { suite: { type: 'string' }, out: { type: 'string' }, qualify: { type: 'boolean' },
    dataset: { type: 'string' }, case: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log('eval:regression -- [--suite evals/regression/suite.json] [--check]\nRun all admitted cases, each with five independent live trials plus real Judge. One failure makes the case zero. --check validates frozen inputs and configuration without model calls.\neval:regression -- --qualify --dataset <dataset.json> --case <ID>\nAdmit/update a case only after a new five-trial regression gate passes. Human review is never fabricated.');
  else {
    if (values.check && (values.qualify || values.dataset || values.case || values.out)) throw Error('--check only accepts --suite');
    const controller = new AbortController(), cancel = () => controller.abort(Error('regression_cancelled')); process.once('SIGINT', cancel);
    try {
      if (values.check) {
        const checked = checkRegressionSuite(values.suite); console.log(JSON.stringify({ status: 'valid', cases: checked.cases.map(c => c.registered.id), trialsPerCase: 5, modelCalls: 0 }));
      } else if (values.qualify) {
        if (!values.dataset || !values.case) throw Error('qualification requires --dataset and --case');
        const result = await qualifyRegressionCase({ dataset: values.dataset, caseId: values.case, suite: values.suite, out: values.out, signal: controller.signal, onEvent: e => console.log(JSON.stringify(e)) });
        console.log(JSON.stringify({ admitted: result.admitted, suite: result.suite, report: result.result.report.markdown, archive: result.result.archive.path, gate: result.result.regression }));
        process.exitCode = result.admitted ? 0 : result.result.exitCode || 1;
      } else {
        if (values.dataset || values.case) throw Error('normal regression runs the complete suite; use --qualify to admit one case');
        const result = await runRegressionSuite({ suite: values.suite, out: values.out, signal: controller.signal, onEvent: e => console.log(JSON.stringify(e)) });
        console.log(JSON.stringify(result)); process.exitCode = result.exitCode;
      }
    } finally { process.removeListener('SIGINT', cancel); }
  }
} catch (error) { console.error(redactor.clean(error instanceof Error ? error.message : 'regression_failed')); process.exitCode = 3; }
