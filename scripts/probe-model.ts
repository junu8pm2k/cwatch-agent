import { existsSync } from 'node:fs';
import { PiModel } from "@cwatch/shared/agent/models";
import { FileStore } from "@cwatch/shared/sessions/storage";
import { Redactor } from "@cwatch/shared/sessions/trace";
import { parseTask } from "@cwatch/core/types";
import { readFileSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const provider = process.env.MODEL_PROVIDER ?? 'unconfigured', modelId = process.env.MODEL_ID ?? 'unconfigured';
const store = new FileStore('artifacts/model-probe');
const redactor = new Redactor(Object.entries(process.env).filter(([k]) => /KEY|TOKEN|SECRET/.test(k)).map(([, v]) => v ?? ''));
const timeout = new AbortController(), handle = setTimeout(() => timeout.abort(new Error('model_probe_timeout')), 30_000);
try {
  const model = PiModel.fromEnvironment();
  const task = parseTask(JSON.parse(readFileSync('examples/task.json', 'utf8')));
  const decision = await model.decide({ state: { task, observations: [], decisions: [], iteration: 0 }, stable: 'Connectivity check. Reply only OK. No tools and no external actions.', volatile: 'Reply OK.', tools: [] }, timeout.signal);
  const result = redactor.clean({ at: new Date().toISOString(), provider, modelId, status: 'connected', decision, usage: model.usage }); store.write('latest.json', result); console.log(JSON.stringify(result, null, 2));
} catch (e) {
  const result = redactor.clean({ at: new Date().toISOString(), provider, modelId, status: 'blocked', error: String(e), configuredCredentialNames: process.env.API_KEY?.trim() ? ['API_KEY'] : [] }); store.write('latest.json', result); console.log(JSON.stringify(result, null, 2)); process.exitCode = 1;
} finally { clearTimeout(handle); }
