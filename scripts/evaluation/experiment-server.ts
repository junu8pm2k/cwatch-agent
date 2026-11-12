import { createServer, type IncomingMessage } from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RemoteTriggerSchema, parseRemoteConfig, type RemoteTrigger, type RemoteProgress } from './remote-experiment.ts';

export interface ExperimentJob extends RemoteProgress {
  id: string; createdAt: string; updatedAt: string; request: RemoteTrigger; fingerprint: string;
}
export interface ExperimentServerOptions {
  directory: string; token: string; projectId: string; port?: number;
  execute: (request: RemoteTrigger, directory: string, progress: (value: RemoteProgress) => void, signal: AbortSignal) => Promise<unknown>;
  sanitize?: (value: string) => string;
  signingSecrets?: Record<string, string>;
}
function equal(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export function verifyExperimentSignature(body: Buffer, header: string, secret: string, now = Date.now()): boolean {
  const match = /^t=([0-9]+),v1=([a-f0-9]{64})$/.exec(header); if (!match || Math.abs(now / 1000 - Number(match[1])) > 300) return false;
  return equal(match[2], createHmac('sha256', secret).update(match[1] + '.').update(body).digest('hex'));
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw Error('json_required');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 65536) { req.resume(); throw Error('request_too_large'); } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
/** Authenticated loopback listener. It cannot accept commands, paths, tools or model credentials. */
export async function startExperimentServer(options: ExperimentServerOptions) {
  if (options.token.length < 32) throw Error('experiment_server_token_too_short');
  const directory = resolve(options.directory); mkdirSync(directory, { recursive: true });
  const jobs = new Map<string, ExperimentJob>(), queue: string[] = [], controllers = new Map<string, AbortController>();
  const clean = options.sanitize ?? ((value: string) => value); let draining = false, closing = false;
  const save = (job: ExperimentJob) => {
    job.updatedAt = new Date().toISOString(); const target = join(directory, job.id); mkdirSync(target, { recursive: true });
    const temporary = join(target, 'status.' + randomUUID() + '.tmp'); writeFileSync(temporary, JSON.stringify(job, null, 2) + '\n'); renameSync(temporary, join(target, 'status.json'));
  };
  for (const name of readdirSync(directory).filter(name => /^[a-f0-9-]{36}$/.test(name))) {
    const file = join(directory, name, 'status.json'); if (!existsSync(file)) continue;
    const job = JSON.parse(readFileSync(file, 'utf8')) as ExperimentJob;
    if (!['completed', 'awaiting_human', 'failed', 'interrupted'].includes(job.stage)) { job.stage = 'interrupted'; job.error = 'Service restarted; original execution is retained and is not automatically rerun.'; save(job); }
    jobs.set(job.id, job);
  }
  const drain = async () => {
    if (draining || closing) return; draining = true;
    try {
      while (queue.length && !closing) {
        const id = queue.shift()!, job = jobs.get(id)!, controller = new AbortController(); controllers.set(id, controller);
        try {
          job.stage = 'starting'; save(job);
          await options.execute(job.request, join(directory, id), value => { Object.assign(job, value); save(job); }, controller.signal);
          if (!['completed', 'awaiting_human'].includes(job.stage)) { job.stage = 'completed'; save(job); }
        } catch (error) { job.stage = controller.signal.aborted ? 'interrupted' : 'failed'; job.error = clean(error instanceof Error ? error.message : 'experiment_failed'); save(job); }
        finally { controllers.delete(id); }
      }
    } finally { draining = false; }
  };
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ready', active: controllers.size, queued: queue.length });
      const authorized = equal(String(req.headers.authorization ?? ''), 'Bearer ' + options.token);
      // Local status contains only run metadata and links; no raw task/response or credential is returned.
      if (req.method === 'GET' && url.pathname === '/jobs') return send(200, [...jobs.values()].slice(-30).reverse().map(({ request, fingerprint, ...job }) => job));
      const match = /^\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && match) {
        const job = jobs.get(match[1]); if (!job) return send(404, { error: 'not_found' });
        const { request, fingerprint, ...visible } = job; return send(200, visible);
      }
      if (req.method !== 'POST' || url.pathname !== '/langfuse/experiments') return send(404, { error: 'not_found' });
      const bytes = await readBody(req), raw = RemoteTriggerSchema.parse(JSON.parse(bytes.toString('utf8')));
      const secret = options.signingSecrets?.[raw.datasetId];
      if (!authorized && !(secret && verifyExperimentSignature(bytes, String(req.headers['x-langfuse-signature'] ?? ''), secret))) return send(401, { error: 'unauthorized' });
      if (raw.projectId !== options.projectId) return send(403, { error: 'project_not_allowed' });
      const config = parseRemoteConfig(raw);
      if (!/^cwatch\/current\/(activation|core_logic|resilience|artifact_quality)$/.test(raw.datasetName)) return send(403, { error: 'dataset_not_allowed' });
      const fingerprint = createHash('sha256').update(JSON.stringify({ ...raw, payload: config })).digest('hex');
      const repeated = [...jobs.values()].find(job => job.fingerprint === fingerprint &&
        (config.requestId || ['queued', 'starting', 'executing', 'publishing', 'judging'].includes(job.stage)));
      if (repeated) return send(202, { accepted: true, reused: true, jobId: repeated.id, statusPath: '/jobs/' + repeated.id });
      if (queue.length + controllers.size >= 8 || closing) return send(409, { error: 'experiment_queue_full' });
      const id = randomUUID(), job: ExperimentJob = { id, stage: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), request: raw, fingerprint };
      jobs.set(id, job); save(job); queue.push(id);
      send(202, { accepted: true, jobId: id, statusPath: '/jobs/' + id });
      setImmediate(() => { void drain(); });
    } catch (error) { send(400, { error: clean(error instanceof Error ? error.message : 'invalid_request') }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(options.port ?? 4311, '127.0.0.1', () => { server.removeListener('error', reject); done(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('server_address_unavailable');
  return { origin: 'http://127.0.0.1:' + address.port, server,
    close: async () => { closing = true; for (const controller of controllers.values()) controller.abort(Error('service_stopped'));
      await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    } };
}
