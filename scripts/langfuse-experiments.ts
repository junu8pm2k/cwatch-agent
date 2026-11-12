import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from './evaluation/langfuse-client.ts';
import { RemoteTriggerSchema, runRemoteExperiment, syncRemoteExperiment } from './evaluation/remote-experiment.ts';
import { startExperimentServer } from './evaluation/experiment-server.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
try {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'serve' }, port: { type: 'string', default: '80' },
    request: { type: 'string' }, job: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('experiments:langfuse -- --mode serve [--port 80]\n--mode run --request <JSON file>\n--mode sync --job <job UUID>\nLocal eval:run / eval:regression remain independent of Langfuse.');
  else {
    const config = readLangfuseConfig(); if (!config) throw Error('langfuse_config_missing'); config.timeoutMs = 30000;
    const client = new LangfuseClient(config), projectId = await client.projectId();
    const directory = resolve('.runtime/langfuse-experiments'); mkdirSync(directory, { recursive: true });
    if (values.mode === 'serve') {
      const port = Number(values.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid_experiment_port');
      const tokenFile = join(directory, 'webhook-token');
      if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      const token = readFileSync(tokenFile, 'utf8').trim();
      const app = await startExperimentServer({ directory: join(directory, 'jobs'), token, projectId, port,
        sanitize: value => redactor.clean(value.split(token).join('[REDACTED]')),
        execute: (request, job, progress, signal) => runRemoteExperiment(client, request, job, progress, signal) });
      // The Docker-only receiver writes a narrow inbox; it has no mount of source, keys or job evidence.
      const inbox = join(directory, 'inbox'); mkdirSync(inbox, { recursive: true }); let importing = false;
      const importDeliveries = async () => {
        if (importing) return; importing = true;
        try {
          for (const name of readdirSync(inbox).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
            const file = join(inbox, name);
            try {
              const delivery = JSON.parse(readFileSync(file, 'utf8'));
              const response = await fetch(app.origin + '/langfuse/experiments', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(delivery.request), signal: AbortSignal.timeout(10000) });
              if (response.status === 409) break;
              const result = await response.json();
              writeFileSync(file + '.result', JSON.stringify(result, null, 2)); renameSync(file, file + (response.ok ? '.accepted' : '.rejected'));
            } catch { /* Leave uncertain deliveries pending; executor deduplicates active requests. */ }
          }
        } finally { importing = false; }
      };
      const inboxTimer = setInterval(() => { void importDeliveries(); }, 1000);
      writeFileSync(join(directory, 'service.json'), JSON.stringify({ pid: process.pid, origin: app.origin, projectId, webhookPath: '/langfuse/experiments', startedAt: new Date().toISOString() }, null, 2) + '\n');
      console.log(JSON.stringify({ status: 'ready', origin: app.origin, webhookPath: '/langfuse/experiments', jobs: app.origin + '/jobs' }));
      const stop = () => { clearInterval(inboxTimer); void app.close().then(() => { process.exitCode = 0; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    } else if (values.mode === 'run') {
      if (!values.request) throw Error('request_file_required');
      const request = RemoteTriggerSchema.parse(JSON.parse(readFileSync(values.request, 'utf8'))), job = join(directory, 'jobs', randomUUID());
      mkdirSync(job, { recursive: true });
      console.log(JSON.stringify(await runRemoteExperiment(client, request, job, value => { writeFileSync(join(job, 'status.json'), JSON.stringify(value, null, 2)); console.log(JSON.stringify(value)); }), null, 2));
    } else if (values.mode === 'sync') {
      if (!values.job || !/^[a-f0-9-]{36}$/.test(values.job)) throw Error('job_uuid_required');
      console.log(JSON.stringify(await syncRemoteExperiment(client, join(directory, 'jobs', values.job)), null, 2));
    } else throw Error('experiment_mode_must_be_serve_run_sync');
  }
} catch (error) { console.error(redactor.clean(error instanceof Error ? error.message : 'remote_experiment_failed')); process.exitCode = 1; }
