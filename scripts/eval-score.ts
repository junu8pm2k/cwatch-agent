import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { humanTemplate, prepareQualitySubject, saveQualityReport, scoreHuman, scoreRules } from './evaluation/quality.ts';
import { JUDGE_LIMITS, readJudgeConfig, scoreLlm } from './evaluation/judge.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? ''));
try {
  const { values } = parseArgs({ options: { kind: { type: 'string', default: 'report' }, report: { type: 'string' }, case: { type: 'string' }, attempt: { type: 'string' },
    template: { type: 'boolean' }, input: { type: 'string' }, timeout: { type: 'string' }, 'max-output-tokens': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(`eval:score -- --report <batch/report.json> [--kind rules --case ID]\neval:judge -- --report <batch/report.json> --case ID [--attempt 1] [--timeout ${JUDGE_LIMITS.timeoutMs}] [--max-output-tokens ${JUDGE_LIMITS.maxOutputTokens}]\neval:human -- --report <batch/report.json> --case ID --template\neval:human -- --report <batch/report.json> --case ID --input <edited-human-input.json>\nLLM Judge uses only JUDGE_MODEL_PROVIDER/JUDGE_MODEL_ID/JUDGE_API_KEY/JUDGE_BASE_URL. Human input must be completed by the actual reviewer. Original results are preserved.`);
  } else {
    if (!values.report) throw Error('provide --report <batch/report.json>');
    if (!['report', 'rules', 'human', 'llm'].includes(values.kind!)) throw Error('invalid_score_kind');
    if (values.kind === 'report') {
      if (values.case || values.input || values.template) throw Error('report_scores_entire_batch');
      const result = saveQualityReport(values.report, redactor); console.log(JSON.stringify({ path: result.path, metrics: result.report.metrics }));
      if (!result.report.metrics.releaseGate) process.exitCode = 1;
    } else {
      if (!values.case) throw Error('provide --case <caseId>');
      if (values.kind !== 'human' && (values.template || values.input)) throw Error('human_input_options_require_human_kind');
      const subject = prepareQualitySubject(values.report, values.case, values.attempt ? Number(values.attempt) : 1, redactor);
      if (values.kind === 'human' && Boolean(values.template) === Boolean(values.input)) throw Error('choose --template or --input for human scoring');
      if ((values.kind === 'llm'&&!subject.llmApplicable)||(values.kind === 'human'&&!subject.humanApplicable)) {
        console.log(JSON.stringify({caseId:values.case,kind:values.kind,status:'not_applicable',reason:'No review criteria assigned; no model request or score created.'}));
      } else if (values.kind === 'human' && values.template) console.log(JSON.stringify(humanTemplate(subject)));
      else {
        const controller = new AbortController(), cancel = () => controller.abort(Error('judge_cancelled'));
        process.once('SIGINT', cancel);
        try {
          const result = values.kind === 'rules' ? scoreRules(subject) : values.kind === 'human' ? scoreHuman(subject, JSON.parse(readFileSync(values.input!, 'utf8')), redactor)
            : await scoreLlm(subject, readJudgeConfig(), { signal: controller.signal, timeoutMs: values.timeout ? Number(values.timeout) : undefined,
              maxOutputTokens: values['max-output-tokens'] ? Number(values['max-output-tokens']) : undefined });
          console.log(JSON.stringify(result)); if (result.record.verdict !== 'ready') process.exitCode = 1;
        } finally { process.removeListener('SIGINT', cancel); }
      }
    }
  }
} catch (error) { console.error(redactor.clean(error instanceof Error ? error.message : 'score_failed')); process.exitCode = 1; }
